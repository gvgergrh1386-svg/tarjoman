"""Read-only third-party player compatibility in a disposable Chrome profile."""
import argparse,json,subprocess,tempfile,time,shutil
from pathlib import Path
import run_harness as h
p=argparse.ArgumentParser();p.add_argument('--faststream',type=Path,required=True);p.add_argument('--danmaku',type=Path,required=True);p.add_argument('--extension',type=Path,default=h.ROOT);p.add_argument('--output',type=Path,default=h.ROOT/'.audit/3.7.5/player-compat');args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
fast=args.faststream.resolve()
danmaku=args.danmaku.resolve()
report={'checks':[],'observations':[]}
def check(name,ok,detail=None):report['checks'].append({'name':name,'ok':bool(ok),'detail':detail});print(('PASS ' if ok else 'FAIL ')+name,flush=True)
with tempfile.TemporaryDirectory(prefix='gxt-player-compat-') as temp:
 temp=Path(temp);port=h.free_port();proc=subprocess.Popen([str(h.find_chrome()),f'--user-data-dir={temp/"profile"}',f'--remote-debugging-port={port}','--enable-unsafe-extension-debugging','--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','about:blank'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);ws=None
 try:
  for i in range(100):
   try:ws=h.cdp.WS(h.cdp.browser_ws(port));break
   except OSError:time.sleep(.15)
  if ws is None:raise RuntimeError('Chrome unavailable')
  ext=ws.call('Extensions.loadUnpacked',{'path':str(args.extension.resolve())})['id'];fid=ws.call('Extensions.loadUnpacked',{'path':str(fast)})['id']
  def ev(session,code):
   r=ws.call('Runtime.evaluate',{'expression':code,'awaitPromise':True,'returnByValue':True},session=session)
   if r.get('exceptionDetails'):raise RuntimeError(str(r['exceptionDetails']))
   return r.get('result',{}).get('value')
  def page(url):
   tid=ws.call('Target.createTarget',{'url':'about:blank'})['targetId'];sid=ws.call('Target.attachToTarget',{'targetId':tid,'flatten':True})['sessionId'];ws.call('Runtime.enable',session=sid);ws.call('Page.enable',session=sid);ws.call('Page.navigate',{'url':url},session=sid);return sid
  own=page(f'chrome-extension://{ext}/popup/popup.html');fs=page(f'chrome-extension://{fid}/player/index.html');time.sleep(1)
  check('FastStream exact installed release loads in isolated Chrome',ev(fs,"chrome.runtime.getManifest().version")=='1.3.45')
  report['observations'].append({'fastStreamPage':ev(fs,"({url:location.href,ready:document.readyState,videos:document.querySelectorAll('video').length,tarjomanHosts:document.querySelectorAll('[data-gxt-web-video]').length})")})
  fast_tab_id=ev(fs,"chrome.tabs.getCurrent().then(t=>t.id)")
  proof=ev(own,"(async()=>{try{await chrome.scripting.executeScript({target:{tabId:"+str(fast_tab_id)+"},func:()=>document.querySelector('video')?.tagName});return {blocked:false}}catch(e){return {blocked:true,error:e.message}}})()")
  check('Chrome blocks ordinary injection into a different extension player',proof.get('blocked') and 'chrome-extension://' in proof.get('error',''),proof)
  target=temp/'danmaku';shutil.copytree(danmaku,target,ignore=shutil.ignore_patterns('_metadata'))
  did=ws.call('Extensions.loadUnpacked',{'path':str(target)})['id'];report['observations'].append({'danmaku':{'id':did,'version':json.loads((target/'manifest.json').read_text(encoding='utf-8'))['version'],'status':'extension loaded; its own PiP launch and playback not verified by this test','limits':'Native Document PiP transfer is tested separately; legacy canvas/video PiP cannot include unrelated DOM overlays.'}})
  check('Danmaku exact installed 0.6.62 can coexist in isolated Chrome',did=='nahbabjlllhocabmecfjmcblchhpoclj' and json.loads((target/'manifest.json').read_text(encoding='utf-8'))['version']=='0.6.62')
 except Exception as e:report['observations'].append({'error':str(e)});check('compatibility run completed',False,str(e))
 finally:
  if ws:
   try:ws.call('Browser.close')
   except Exception:pass
   ws.close()
  try:proc.wait(timeout=10)
  except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=5)
report['passed']=sum(x['ok'] for x in report['checks']);report['total']=len(report['checks']);(args.output/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False));raise SystemExit(0 if report['passed']==report['total'] else 1)
