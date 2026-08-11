const test=require('node:test');
const assert=require('node:assert/strict');
const control=require('../modules/cellular-control.js');
test('WAN discovery is universal and read-only',async()=>{const result=await control.detect({xmlRequest:async()=>'<RGW><wan><connect_mode>auto</connect_mode></wan></RGW>'});assert.equal(result.supported,true);assert.equal(result.readOnly,true);assert.deepEqual(result.modes,[]);});
test('cellular writes remain disabled without a universal contract',async()=>{assert.equal((await control.executeReconnect()).outcome,'unsupported');assert.equal((await control.executeSetMode()).outcome,'unsupported');assert.equal(control.modeById('auto'),null);});
