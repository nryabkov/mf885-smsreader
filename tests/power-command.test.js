const test=require('node:test');
const assert=require('node:assert/strict');
const app=require('../scriptable.js');
test('power commands are explicitly disabled',async()=>{await assert.rejects(app.executePowerCommand({},'reboot'),/no universal command contract/);await assert.rejects(app.executePowerCommand({},'powerOff'),/no universal command contract/);});
