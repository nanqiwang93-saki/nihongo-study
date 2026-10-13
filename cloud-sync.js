/* 日本語の旅 · Firebase 同步（v2）：本地优先、登录后按需同步。 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js';
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';
import { getFirestore, doc, getDoc, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

const config = {
  apiKey: 'AIzaSyCbSbEupYas56gUt6EAq9Xri6bpKIskGRM',
  authDomain: 'nihongo-study-7a640.firebaseapp.com',
  projectId: 'nihongo-study-7a640',
  appId: '1:423672485596:web:5ebee719b5b32a89024619'
};
const app = initializeApp(config);
const auth = getAuth(app);
const db = getFirestore(app);
const bridge = window.NihongoBridge;
if (!bridge) throw new Error('无法连接本地学习记录');
let user = null;
let ready = false;
let conflict = null;
let writeTimer = 0;
let saving = Promise.resolve();
let currentRequest = 0;
let lastRemote = null;
let conflictBackupConfirmed = false;

const style = document.createElement('style');
style.textContent = `
.cloud-launch{border:1px solid #ded5ed;border-radius:25px;padding:8px 12px;background:#f3edfb;color:#59417f;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
.cloud-launch:hover{background:#ebe2f7}
.cloud-shade[hidden]{display:none!important}
.cloud-shade{position:fixed;inset:0;z-index:9999;background:rgba(29,22,45,.55);display:flex;align-items:center;justify-content:center;padding:16px}
.cloud-modal{background:#fff;color:#292336;border-radius:20px;padding:27px;width:min(440px,100%);box-shadow:0 25px 75px rgba(29,22,45,.2);max-height:min(90vh,760px);overflow:auto}
.cloud-modal h2{font-size:23px;margin:0 0 8px}.cloud-modal p{font-size:13px;line-height:1.7;color:#786f82;margin:7px 0 16px}
.cloud-modal label{display:block;font-size:13px;font-weight:600;margin:12px 0 6px}
.cloud-modal input{display:block;width:100%;padding:12px;border:1px solid #ddd4e9;border-radius:10px;font:inherit;font-size:14px}
.cloud-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:17px}.cloud-btn{background:#7555a7;border:1px solid #7555a7;color:white;border-radius:10px;padding:11px 15px;font:inherit;font-weight:650;cursor:pointer}
.cloud-btn.secondary{background:#f5f1fa;color:#59417f;border-color:#e6dcee}.cloud-btn.danger{background:#fff4f4;color:#b94e5b;border-color:#f1d7da}
.cloud-btn:disabled{opacity:.55;cursor:wait}.cloud-message{min-height:25px;margin-top:13px;font-size:12px;color:#5c5180;line-height:1.6}
.cloud-close{float:right;border:0;background:transparent;color:#817b8d;font-size:23px;cursor:pointer}.cloud-choice{background:#fbf9fd;border:1px solid #e7def2;border-radius:12px;padding:13px;margin-top:12px}
.cloud-choice h3{margin:0;font-size:15px}.cloud-mini{font-size:11px;color:#817b8d;margin-top:12px;line-height:1.6}
@media(max-width:700px){.topbar-right .local-status,.topbar-right #today-text{display:none}.cloud-launch{padding:7px 9px;font-size:11px}.cloud-modal{padding:20px}}
`;
document.head.appendChild(style);
const trigger = document.createElement('button');
trigger.id = 'cloud-launch';
trigger.type = 'button';
trigger.className = 'cloud-launch';
trigger.textContent = '☁ 云同步 · 检查登录';
document.querySelector('.topbar-right')?.prepend(trigger);
const modal = document.createElement('div');
modal.className = 'cloud-shade';
modal.hidden = true;
modal.innerHTML = `
<section class="cloud-modal" role="dialog" aria-modal="true" aria-labelledby="cloud-heading">
  <button type="button" class="cloud-close" aria-label="关闭登录窗口" id="cloud-close">×</button>
  <h2 id="cloud-heading">☁ 我的学习云端</h2>
  <p>使用同一个邮箱账号，在电脑、手机和 iPad 之间同步学习记录。GitHub 不需要登录。</p>
  <div id="cloud-guest">
    <form id="cloud-auth-form">
      <label for="cloud-email">邮箱</label><input id="cloud-email" type="email" autocomplete="email" required placeholder="your@email.com">
      <label for="cloud-password">密码（至少 6 位）</label><input id="cloud-password" type="password" autocomplete="current-password" minlength="6" required>
      <div class="cloud-actions"><button class="cloud-btn" id="cloud-login" type="submit">登录</button><button class="cloud-btn secondary" id="cloud-register" type="button">首次使用 · 注册</button></div>
    </form>
  </div>
  <div id="cloud-member" hidden>
    <p>已登录：<strong id="cloud-address"></strong></p>
    <p id="cloud-sync-status">正在连接云端…</p>
    <div class="cloud-actions"><button class="cloud-btn secondary" id="cloud-retry" type="button">重新检查同步</button><button class="cloud-btn secondary" id="cloud-logout" type="button">退出账号</button></div>
  </div>
  <div class="cloud-choice" id="cloud-conflict" hidden>
    <h3>发现两份不同的学习进度</h3>
    <p>这台设备与云端都有记录。请先下载本机备份，再选择保留哪一份；如果两台设备都有新记录，建议先保存两个版本再决定。</p>
    <div class="cloud-actions"><button class="cloud-btn secondary" id="cloud-backup" type="button">① 下载本机备份</button><button class="cloud-btn" id="cloud-take" type="button">② 使用云端记录</button><button class="cloud-btn danger" id="cloud-send" type="button">② 用本机记录覆盖云端</button></div>
  </div>
  <div class="cloud-message" id="cloud-message" aria-live="polite"></div>
  <div class="cloud-mini">云同步依赖网络；若显示同步失败，新的修改仍会保存在当前浏览器。请定期从「设置与备份」导出 JSON。退出账号不会自动清除这台设备的本地记录。</div>
</section>`;
document.body.appendChild(modal);
const el = id => document.getElementById(id);
const showMessage = message => {el('cloud-message').textContent = message;};
const setStatus = text => {trigger.textContent = '☁ '+text; el('cloud-sync-status').textContent = text;};
const setBusy = busy => {for(const id of ['cloud-login','cloud-register','cloud-retry','cloud-send','cloud-take'])el(id).disabled = busy;};
const lastKey = () => `nihongo-cloud-last.v2:${user?.uid || 'none'}`;
const asText = data => JSON.stringify(data);
function meaningful(data){
  return Object.values(data.lessons || {}).some(v=>v>0) || (data.cards||[]).length>0 || (data.logs||[]).length>0 || (data.exams||[]).length>0 ||
    Object.values(data.taskDays||{}).some(x=>(x.items||[]).some(i=>i.done)) || data.energy!=='normal' || data.goal!=='2027-07';
}
const reference = () => doc(db,'users',user.uid,'sync','main');
function errorText(err) {
  const reasons = {
    'auth/invalid-email':'邮箱格式不正确。',
    'auth/invalid-credential':'账号或密码不正确。',
    'auth/email-already-in-use':'此邮箱已注册，请直接登录。',
    'auth/weak-password':'密码太简单，请至少设置 6 位。',
    'auth/too-many-requests':'尝试过于频繁，请稍后再试。',
    'auth/network-request-failed':'网络连接 Firebase 失败，请检查网络。',
    'auth/operation-not-allowed':'Firebase 尚未开启邮箱密码登录。',
    'auth/unauthorized-domain':'网站域名未添加到 Firebase 授权列表。',
    'permission-denied':'数据库拒绝访问，请检查 Firestore 安全规则。'
  };
  return reasons[err?.code] || `无法完成操作：${err?.message || '网络或权限问题'}`;
}
function setReady(snapshot){ready=true;conflict=null;el('cloud-conflict').hidden=true;localStorage.setItem(lastKey(), asText(snapshot));setStatus('已同步');showMessage('同步已启用。以后在任意设备用同一邮箱登录即可恢复进度。');}
function takeCloud(payload){lastRemote=asText(payload);bridge.replace(payload);setReady(bridge.read());}
async function pushCloud(){
  if(!user || !ready)return false;
  const target = user;
  const payload = bridge.read();
  const before = asText(payload);
  const expected = lastRemote;
  setStatus('同步中…');
  try {
    const dest = doc(db,'users',target.uid,'sync','main');
    await runTransaction(db,async tx=>{
      const snap = await tx.get(dest);
      const live = snap.exists()?asText(snap.data().payload):null;
      if(live!==expected){
        const err=new Error('其他设备已更新云端记录');
        err.code='sync/conflict';
        err.remote=snap.exists()?snap.data().payload:null;
        throw err;
      }
      tx.set(dest,{payload,updatedAt:serverTimestamp(),schemaVersion:1});
    });
    if(user?.uid!==target.uid)return false;
    lastRemote=before;
    localStorage.setItem(lastKey(),before);
    if(asText(bridge.read())!==before){queueUpload();return true;}
    setStatus('已同步');
    showMessage('云端记录已更新。');
    return true;
  } catch(err){
    if(user?.uid!==target.uid)return false;
    if(err.code==='sync/conflict'){
      // Another device changed the remote copy: do not overwrite silently.
      ready=false;
      conflict=err.remote;
      conflictBackupConfirmed=false;
      el('cloud-conflict').hidden=false;
      modal.hidden=false;
      setStatus('发现云端更新 · 等待选择');
      showMessage('其他设备有更新。请先备份本机记录，再决定保留哪个版本。');
    } else {
      setStatus('云端失败 · 本机已保存');showMessage(errorText(err));
    }
    return false;
  }
}
function queueUpload(){
  if(!ready || !user)return;
  clearTimeout(writeTimer);
  setStatus('等待同步…');
  writeTimer = window.setTimeout(()=>{saving=saving.catch(()=>{}).then(pushCloud);},650);
}
window.addEventListener('nihongo:changed',queueUpload);
window.addEventListener('online',()=>{if(user && ready)queueUpload();});
// To refresh after edits on another device, reload the page or use '重新检查同步'.
async function initializeCloud(){
  if(!user)return;
  const thisUser = user;
  const token=++currentRequest;
  ready=false;conflict=null;lastRemote=null;conflictBackupConfirmed=false;setStatus('读取云端…');el('cloud-conflict').hidden=true;
  showMessage('正在检查云端是否已有记录。');setBusy(true);
  try {
    const snap=await getDoc(reference());
    if(token!==currentRequest || user?.uid!==thisUser.uid)return;
    const local = bridge.read();
    if(!snap.exists()){
      ready=true;
      const ok=await pushCloud();
      if(ok && token===currentRequest)showMessage('已创建你的第一份云端学习记录。');
    } else {
      const remote=snap.data().payload;
      if(!remote || Number(remote.version)!==1)throw new Error('云端记录格式不兼容，请先导出本地备份。');
      lastRemote=asText(remote);
      const l=asText(local), r=lastRemote,last=localStorage.getItem(lastKey());
      if(l===r){setReady(local);}
      else if(!meaningful(local) || (last!==null && l===last)){
        takeCloud(remote);
      } else if(!meaningful(remote) || (last!==null && r===last)){
        ready=true;const ok=await pushCloud();if(ok)showMessage('已将本机的新记录同步到云端。');
      } else {
        conflict=remote;conflictBackupConfirmed=false;el('cloud-conflict').hidden=false;setStatus('待选择记录');
        showMessage('请下载备份并选择云端或本机版本。选择前不会覆盖任何记录。');
        modal.hidden=false;
      }
    }
  } catch(err){if(token===currentRequest){setStatus('云端连接失败');showMessage(errorText(err));}}
  finally{if(token===currentRequest)setBusy(false);}
}
trigger.addEventListener('click',()=>{modal.hidden=false;el('cloud-email').focus();});
el('cloud-close').addEventListener('click',()=>{modal.hidden=true;});
modal.addEventListener('click',e=>{if(e.target===modal)modal.hidden=true;});
document.addEventListener('keydown',e=>{if(e.key==='Escape')modal.hidden=true;});
async function runAuth(mode){
  const email=el('cloud-email').value.trim(),password=el('cloud-password').value;
  if(!email || password.length<6){showMessage('请输入有效邮箱和至少 6 位密码。');return;}
  setBusy(true);showMessage('正在连接账号…');
  try{
    if(mode==='register')await createUserWithEmailAndPassword(auth,email,password);
    else await signInWithEmailAndPassword(auth,email,password);
    modal.hidden=false;
  }catch(err){showMessage(errorText(err));}
  finally{setBusy(false);}
}
el('cloud-auth-form').addEventListener('submit',e=>{e.preventDefault();runAuth('login');});
el('cloud-register').addEventListener('click',()=>runAuth('register'));
el('cloud-logout').addEventListener('click',async()=>{if(!confirm('退出账号后，此浏览器仍会保存本地学习记录。确定退出吗？'))return;clearTimeout(writeTimer);try{await saving;}catch{} await signOut(auth);showMessage('已退出云端账号，本地记录仍保留在此浏览器。');});
el('cloud-retry').addEventListener('click',initializeCloud);
el('cloud-backup').addEventListener('click',()=>{bridge.backup();conflictBackupConfirmed=true;showMessage('已请求下载本机备份。请确认文件已保存，再选择保留哪份记录。');});
el('cloud-take').addEventListener('click',()=>{if(!conflict)return;if(!conflictBackupConfirmed){showMessage('请先点击「下载本机备份」。');return;}if(!confirm('确认用云端记录替换当前设备的记录？请确认备份文件已保存。'))return;takeCloud(conflict);});
el('cloud-send').addEventListener('click',async()=>{if(!conflict)return;if(!conflictBackupConfirmed){showMessage('请先点击「下载本机备份」。');return;}if(!confirm('确认用当前设备的记录覆盖云端？请确认备份文件已保存。'))return;lastRemote=asText(conflict);ready=true;conflict=null;el('cloud-conflict').hidden=true;await pushCloud();});
try{await setPersistence(auth,browserLocalPersistence);}catch(err){showMessage('浏览器可能无法记住登录状态：'+errorText(err));}
onAuthStateChanged(auth, async account=>{
  clearTimeout(writeTimer);currentRequest++;ready=false;conflict=null;
  user=account;lastRemote=null;
  el('cloud-member').hidden=!account;
  el('cloud-guest').hidden=!!account;
  if(!account){setStatus('登录后同步');el('cloud-conflict').hidden=true;return;}
  el('cloud-address').textContent=account.email || '已登录账号';
  await initializeCloud();
});