const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const root=path.join(__dirname,"..");
const script=fs.readFileSync(path.join(root,"firmware/webui-canary-logs/canary_logs.js"),"utf8");
const builder=fs.readFileSync(path.join(root,"tools/mf885_webi_builder.py"),"utf8");

test("WEBI log Canary is syntactically valid and observer-only",()=>{
  assert.doesNotThrow(()=>new Function(script));
  assert.match(script,/MF885 Community Canary Logs 0\.0-logs-r1/);
  for(const hook of ["XMLHttpRequest.prototype.open","XMLHttpRequest.prototype.send","window.fetch","addEventListener('submit'","addEventListener('click'","console.'+name","unhandledrejection"]){
    assert.match(script,new RegExp(hook.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  }
  assert.match(script,/file=detailed_log/);
  assert.match(script,/SMS payload hidden/);
  assert.doesNotMatch(script,/RestoreFw|file=reset|file=poweroff|restore_defaults|debugmodeon/i);
});

test("WEBI builder is exact-golden, fixed-size-index and fail-closed",()=>{
  assert.match(builder,/2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531/);
  assert.match(builder,/INDEX_LOADER = b'<script src="js\/canary_logs\.js"><\/script>'/);
  assert.match(builder,/len\(match\.group\(1\)\) != len\(INDEX_LOADER\)/);
  assert.match(builder,/0xCAFE1000/);
  assert.match(builder,/zlib\.adler32/);
  assert.match(builder,/inspector\.byte_sum/);
  assert.match(builder,/non-WEBI partition changed/);
  assert.match(builder,/"flash_qualified": False/);
  assert.match(builder,/"restore_allowlisted": False/);
});
