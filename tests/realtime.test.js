import { PROTOCOL_BASELINE } from '../src/protocol-baseline.js';
import { compareFingerprint, fingerprintComplete } from '../src/data.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {acceptLiveSnapshot, snapshotFromEvidence} from '../src/data.js';
import {compute, EXAMPLE_VALUES, applyMarket} from '../src/ui.js';
const now=Date.parse('2026-10-26T00:00:00Z');
const fresh=()=>{const s=snapshotFromEvidence(JSON.parse(readFileSync('evidence/snapshot.json')).rawEvidence); s.mode='LIVE'; s.meta={...s.meta,fetchedAt:new Date(now).toISOString(),chainId:6714,blockTimestamp:now/1000,blockHash:'0xabc',fingerprint:{chainId:6714,contracts:{a:{codeHash:'abc',impl:'0x0'}}}}; for(const v of Object.values(s.values)){if(v.status!=='ASSUMED'&&v.value!==null)v.status='OBSERVED';v.fetchedAt=s.meta.fetchedAt;}return s;};
const f={...EXAMPLE_VALUES,asset:'DAI',amount:'1000',startDate:'2026-10-26',horizonYears:'1',requireLive:true};
test('live-required calculation rejects saved, expired, failed and changed implementation inputs',()=>{
 assert.deepEqual(compute(f,fresh(),null,now).errors,[]);
 for(const change of [s=>s.mode='SAVED',s=>s.meta.fetchedAt='2026-10-23T00:00:00Z',s=>s.values.annualRateBps.status='STALE',s=>s.values.dayStart.value=null,s=>s.meta.verification='PENDING_VERIFICATION',s=>s.meta.chainId=1,s=>s.meta.blockTimestamp-=301]) {
  const s=fresh();change(s);assert.ok(compute(f,s,null,now).errors.length,'must reject invalid current data');
 }
 assert.ok(compute(f,fresh(),null,now+301000).errors.length);
});
test('AUTO AiLGNS never silently falls back to stored TWAP',()=>{
 const m=applyMarket({...f,'market.ailgns':'AUTO'}, {legs:{}}, now);
 assert.ok(m.errors.some(x=>x.includes('AiLGNS')));
 assert.notEqual(m.use.ailgns.source,'SAVED_TWAP');
});

test('live-required rejects yesterday, missing LGNS spot and missing displayed FX',()=>{
 assert.ok(compute({...f,startDate:'2026-10-25'},fresh(),null,now).errors.length);
 assert.ok(applyMarket({...f,'market.fx':'AUTO'}, {legs:{}},now).errors.length);
 assert.ok(applyMarket({...f,asset:'LGNS',lgnsChain:'anubis','market.lgns':'AUTO'}, {legs:{}},now).errors.length);
});

test('post-settlement burns reject zero-day activation instead of silently treating it as one day',()=>{
 assert.ok(compute({...f,asset:'LGNS',lgnsChain:'anubis',route:'ANUBIS_LGNS_BURN','engine.entryLagDays':'0'},fresh(),null,now).errors.length);
 assert.ok(compute({...f,'engine.reburnLagDays':'0'},fresh(),null,now).errors.length);
});

test('optional unsettled metrics may be null without reviving previous-day values or blocking current inputs',()=>{
 const s=fresh();s.values.communityActualToday.value=null;s.values.communityActualToday.status='UNAVAILABLE';
 const accepted=acceptLiveSnapshot(s,now);
 assert.equal(accepted.values.communityActualToday.value,null);
 assert.deepEqual(compute(f,accepted,null,now).errors,[]);
 const missing=fresh();missing.values.annualRateBps.value=null;missing.values.annualRateBps.status='UNAVAILABLE';
 assert.ok(compute(f,acceptLiveSnapshot(missing,now),null,now).errors.length);
});

test('shipped identity baseline survives reload and detects changed contract code',()=>{
 assert.equal(fingerprintComplete(PROTOCOL_BASELINE.fingerprint),true);
 assert.equal(PROTOCOL_BASELINE.fingerprint.chainId,6714);
 const changed=structuredClone(PROTOCOL_BASELINE.fingerprint);
 Object.values(changed.contracts)[0].codeHash='changed';
 assert.ok(compareFingerprint(PROTOCOL_BASELINE.fingerprint,changed).length);
 assert.deepEqual(compareFingerprint(PROTOCOL_BASELINE.fingerprint,structuredClone(PROTOCOL_BASELINE.fingerprint)),[]);
});
