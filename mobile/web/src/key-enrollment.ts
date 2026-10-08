import { shellQuote } from '../../../tabby-ssh/src/session/tmuxCore'
import { type SSHBridge, type SSHEvent, encodeBytes } from './bridge'
import { secureUUID } from './web-platform'

export interface DeviceKey {
    id: string
    createdAt: number
    enrollment?: 'local_only' | 'installed' | 'verified' | 'uncertain'
    target: { host: string, port: number, username: string, hostKey: string }
    public: { algorithm: 'ssh-ed25519', publicKey: string, fingerprint: string }
}
export interface EnrollmentPlan { uid: number, account: string, home: string, path: string, token: string }

/** Executed only on the selected authenticated account. No sudo, chmod, replacement or remote deletion. */
export const KEY_INSTALLER = String.raw`import os,sys,json,base64,stat,fcntl,hashlib,pwd,ctypes,re
class Stop(Exception): pass
def require(test,code):
 if not test: raise Stop(code)
def ident(s): return [s.st_dev,s.st_ino,s.st_uid,s.st_mode,s.st_nlink]
def main():
 require(sys.platform=="linux","unsupported_platform")
 p=json.loads(base64.b64decode(sys.argv[1],validate=True))
 require(p["mode"] in ["inspect","install"],"invalid_request")
 public=p["publicKey"]
 require(isinstance(public,str) and re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]+={0,2}",public) is not None,"invalid_key")
 blob=base64.b64decode(public.split()[1],validate=True)
 require(len(blob)==51 and blob[:19]==b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20","invalid_key")
 uid=os.geteuid(); require(uid!=0 and uid==os.getuid(),"ordinary_account_required")
 home=os.environ.get("HOME","")
 require(home.startswith("/") and home!="/" and os.path.normpath(home)==home and len(home)<4096 and not any(ord(c)<32 or ord(c)==127 for c in home),"unsafe_home")
 acl=ctypes.CDLL("libacl.so.1",use_errno=True)
 acl.acl_get_fd.argtypes=[ctypes.c_int]; acl.acl_get_fd.restype=ctypes.c_void_p
 acl.acl_get_file.argtypes=[ctypes.c_char_p,ctypes.c_int]; acl.acl_get_file.restype=ctypes.c_void_p
 acl.acl_to_text.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ssize_t)]; acl.acl_to_text.restype=ctypes.c_void_p
 acl.acl_free.argtypes=[ctypes.c_void_p]
 def acl_text(value):
  require(bool(value),"acl_unavailable")
  text=None
  try:
   size=ctypes.c_ssize_t(); text=acl.acl_to_text(value,ctypes.byref(size))
   require(bool(text) and 0<=size.value<=8192,"acl_unavailable")
   return ctypes.string_at(text,size.value).decode("ascii")
  finally:
   if text: acl.acl_free(text)
   acl.acl_free(value)
 def safe(fd,directory,ancestor=False):
  s=os.fstat(fd)
  require((stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)),"unsafe_type")
  require(s.st_uid in ([0,uid] if ancestor else [uid]),"unsafe_owner")
  sticky=ancestor and s.st_uid==0 and bool(s.st_mode&stat.S_ISVTX)
  require(not(s.st_mode&0o022) or sticky,"unsafe_permissions")
  require(directory or s.st_nlink==1,"unsafe_links")
  entries=[v for v in acl_text(acl.acl_get_fd(fd)).splitlines() if v]
  require(len(entries)==3 and sorted(v.split(":",2)[0:2] for v in entries)==[["group",""],["other",""],["user",""]],"extended_acl")
  if directory: require(acl_text(acl.acl_get_file(("/proc/self/fd/"+str(fd)).encode(),0x4000)).strip()=="","default_acl")
  return s
 flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
 fds=[]; links=[]
 def opened(name,parent):
  fd=os.open(name,flags,dir_fd=parent); fds.append(fd); return fd
 try:
  root=os.open("/",flags); fds.append(root); safe(root,True,True)
  current=root; chain=[]
  for part in home.split("/")[1:]:
   parent=current; current=opened(part,parent)
   s=safe(current,True,True); chain.append(ident(s)); links.append((parent,part,current))
  safe(current,True); homefd=current
  # O_APPEND atomicity is not reliable on network filesystems. Reject unknown filesystems.
  libc=ctypes.CDLL(None,use_errno=True); buf=ctypes.create_string_buffer(256)
  require(libc.fstatfs(homefd,ctypes.byref(buf))==0,"filesystem_unavailable")
  magic=ctypes.c_long.from_buffer(buf).value & 0xffffffff
  require(magic in [0xef53,0x01021994,0x794c7630,0x9123683e,0x58465342],"unsupported_filesystem")
  ssh=None; file=None
  try: ssh=opened(".ssh",homefd)
  except FileNotFoundError: pass
  ss=safe(ssh,True) if ssh is not None else None
  if ssh is not None:
   try: file=os.open("authorized_keys",os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=ssh); fds.append(file)
   except FileNotFoundError: pass
  fs=safe(file,False) if file is not None else None
  old=b""
  if file is not None:
   fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
   require(fs.st_size<=1048576,"file_too_large"); old=os.read(file,1048577); require(len(old)<=1048576,"file_too_large")
   require(os.fstat(file).st_mtime_ns==fs.st_mtime_ns and os.fstat(file).st_size==fs.st_size,"concurrent_change")
  snapshot=[uid,home,chain,ident(ss) if ss else None,ident(fs) if fs else None,hashlib.sha256(old).hexdigest()]
  token=hashlib.sha256(json.dumps(snapshot,separators=(",",":")).encode()+public.encode()).hexdigest()
  result={"uid":uid,"account":pwd.getpwuid(uid).pw_name,"home":home,"path":home+"/.ssh/authorized_keys","token":token}
  if p["mode"]=="inspect": return result
  require(p.get("token")==token,"target_changed")
  def same(parent,name,fd):
   s=os.stat(name,dir_fd=parent,follow_symlinks=False); require(ident(s)==ident(os.fstat(fd)),"concurrent_change")
  for parent,name,fd in links: same(parent,name,fd)
  if ssh is None:
   os.mkdir(".ssh",0o700,dir_fd=homefd); ssh=opened(".ssh",homefd); safe(ssh,True)
  same(homefd,".ssh",ssh)
  if file is None:
   file=os.open("authorized_keys",os.O_RDWR|os.O_APPEND|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=ssh); fds.append(file)
   fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB); safe(file,False)
  else:
   writefd=os.open("authorized_keys",os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=ssh); fds.append(writefd)
   require(ident(os.fstat(writefd))==ident(fs),"concurrent_change"); file=writefd
  same(ssh,"authorized_keys",file); safe(file,False)
  # Options may contain quoted spaces; recognize the actual algorithm/blob fields, never strip restrictions.
  for line in old.decode("utf-8",errors="strict").splitlines():
   if not line.strip() or line.lstrip().startswith("#"): continue
   fields=re.findall(r'(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*")+',line)
   for i in [0,1]:
    if len(fields)>i+1 and fields[i]=="ssh-ed25519" and fields[i+1]==public.split()[1]:
     return dict(result,status="already_present")
  require(os.fstat(file).st_size==len(old),"concurrent_change")
  if fs is not None: require(os.fstat(file).st_mtime_ns==fs.st_mtime_ns and os.fstat(file).st_ctime_ns==fs.st_ctime_ns,"concurrent_change")
  data=(b"\n" if old and not old.endswith(b"\n") else b"")+public.encode()+b"\n"
  require(os.write(file,data)==len(data),"write_uncertain"); os.fsync(file); os.fsync(ssh)
  same(homefd,".ssh",ssh); same(ssh,"authorized_keys",file)
  return dict(result,status="added")
 finally:
  for fd in reversed(fds): os.close(fd)
try: print(json.dumps(main(),separators=(",",":")))
except Stop as e: print(json.dumps({"error":str(e)})); sys.exit(1)
except BaseException: print('{"error":"installation_unavailable_or_uncertain"}'); sys.exit(1)
`

export function enrollmentCommand(publicKey: string, plan?: EnrollmentPlan): string {
    const payload = encodeBytes(new TextEncoder().encode(JSON.stringify({ mode: plan ? 'install' : 'inspect', publicKey, ...(plan ? { token: plan.token } : {}) })))
    return `python3 -c ${shellQuote(KEY_INSTALLER)} ${shellQuote(payload)}`
}

/** Fresh transport, pinned host, exactly one public-key method, no PTY/shell or password fallback. */
export async function verifyDeviceKey(bridge: SSHBridge, key: DeviceKey, signal: AbortSignal): Promise<void> {
    const ownerId = `key-check-${secureUUID()}`
    const generation = 1
    let connectionId: string | undefined
    let verifiedHost = false
    let answered = false
    let settled = false
    const early: SSHEvent[] = []
    let resolve!: () => void; let reject!: (error: Error) => void
    const result = new Promise<void>((yes, no) => {
        resolve = () => { if (!settled) { settled = true; yes() } }
        reject = error => { if (!settled) { settled = true; no(error) } }
    })
    void result.catch(() => {})
    const stop = () => reject(new Error('verification_cancelled'))
    const event = (e: SSHEvent) => {
        if (settled || signal.aborted) return
        if (e.ownerId !== ownerId || e.generation !== generation) return
        if (!connectionId) { if (early.length < 32) early.push(e); else reject(new Error('verification_failed')); return }
        if (e.connectionId !== connectionId) return
        if (e.type === 'hostKey') {
            if (e.status !== 'known' || e.keyBase64 !== key.target.hostKey) reject(new Error('verification_host_changed'))
            else verifiedHost = true
        } else if (e.type === 'auth') {
            if (answered || !verifiedHost || e.mode !== 'privateKey' || !Number.isSafeInteger(e.requestId)) { reject(new Error('verification_failed')); return }
            answered = true
            void bridge.command({ connectionId, command: { type: 'authResponse', requestId: e.requestId!, deviceKeyId: key.id } })
                .catch(() => reject(new Error('device_key_unavailable')))
        } else if (e.type === 'state' && e.state === 'authenticated') {
            const endpoint = e.nativeEndpoint
            if (!verifiedHost || e.deferredTerminal !== true || e.verifiedHostKey !== key.target.hostKey || !endpoint ||
                endpoint.host.toLowerCase() !== key.target.host || endpoint.port !== key.target.port || endpoint.username !== key.target.username) reject(new Error('verification_failed'))
            else resolve()
        } else if (e.type === 'state' && (e.state === 'error' || e.state === 'closed')) reject(new Error(e.code === 'auth_partial_success' ? 'additional_auth_required' : 'verification_failed'))
    }
    const listener = await bridge.addListener('sshEvent', event)
    const timer = setTimeout(() => reject(new Error('verification_timeout')), 30000)
    signal.addEventListener('abort', stop, { once: true })
    try {
        if (signal.aborted) throw new Error('verification_cancelled')
        const started = await bridge.start({ ...key.target, generation, ownerId, authMode: 'deviceKey', deferTerminal: true, cols: 80, rows: 24, term: 'xterm-256color' })
        connectionId = started.connectionId
        early.forEach(event)
        await result
    } finally {
        clearTimeout(timer); signal.removeEventListener('abort', stop); await listener.remove()
        if (connectionId) await bridge.close({ connectionId }).catch(() => {})
    }
}
