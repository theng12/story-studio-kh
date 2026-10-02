import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, h, nextTick, ref, type Component } from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const filename = fileURLToPath(new URL('../pages/broll-library.vue', import.meta.url))
async function loadPage(): Promise<Component> {
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'broll-library-scope' })
  const vueUrl = import.meta.resolve('vue')
  const support = `
    import { ref, computed, watch, onMounted, onBeforeUnmount, h, defineComponent as _defineComponent } from ${JSON.stringify(vueUrl)}
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useBrollPools = () => globalThis.__brollFixture.broll
    const useConfirm = () => ({ ask: (...args) => globalThis.__brollFixture.ask(...args) })
    const useToast = () => ({success:()=>undefined, error:()=>undefined})
    const useAppJobs = () => ({jobs:ref([]),onJobDone:()=>()=>undefined})
    const useRoute = () => ({query:{}})
    const useRouter = () => ({replace:()=>undefined})
    const useApi = () => ({get:async()=>({records:[]})})
    const pickFolder = async () => undefined
    const customerSafeJobText = value => value
    const jobRequestIds = () => []
  `
  const content = script.content.replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '').replace('export default', 'const __sfc__ =')
  const out = await transform(`${support}\n${content}\nconst setup = __sfc__.setup
    __sfc__.setup = (props, ctx) => {
      const state = setup(props, ctx); globalThis.__brollFixture.state = state
      return () => h('main')
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)).default
}
function deferred<T>() {
  let resolve!: (value:T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return {promise, resolve}
}
async function flush() { for (let i=0;i<6;i++) await nextTick() }
async function mount(overrides: Record<string, any> = {}) {
  const pools = ref([{id:'A',name:'Pool A',online:true,folder_path:'/a'}, {id:'B',name:'Pool B',online:true,folder_path:'/b'}])
  const fixture:any = {broll:{pools,loading:ref(false),loadPools:async()=>undefined,listClips:async(id:string)=>({clips:[{filename:`${id}.png`}]}),...overrides},ask:async()=>true}
  ;(globalThis as any).__brollFixture = fixture
  const host=document.body.appendChild(document.createElement('div'))
  const app=createApp(await loadPage()); app.mount(host); await flush()
  return {...fixture, dispose(){app.unmount();host.remove()}}
}

test('late pool A files cannot overwrite pool B after switching', async()=>{
  const a=deferred<any>()
  const f=await mount({listClips:async(id:string)=> id==='A'?a.promise:{clips:[{filename:'B.png'}]}})
  try {
    f.state.selectedPoolId.value='B';await flush()
    assert.equal(f.state.clips.value[0].filename,'B.png')
    a.resolve({clips:[{filename:'A.png'}]});await flush()
    assert.equal(f.state.clips.value[0].filename,'B.png')
  } finally {f.dispose()}
})

test('switching pools clears old files immediately while next pool loads',async()=>{
  const b=deferred<any>()
  const f=await mount({listClips:async(id:string)=>id==='B'?b.promise:{clips:[{filename:'A.png'}]}})
  try {
    f.state.selectedPoolId.value='B';await nextTick()
    assert.deepEqual(f.state.clips.value,[])
    b.resolve({clips:[]});await flush()
  }finally{f.dispose()}
})

test('scan completing on A cannot attach results to B',async()=>{
  const scan=deferred<any>();const calls:string[]=[]
  const f=await mount({scanPool:()=>scan.promise,listClips:async(id:string)=>{calls.push(id);return {clips:[{filename:`${id}.png`}]}}})
  try {
    const run=f.state.runScan();f.state.selectedPoolId.value='B';await flush()
    scan.resolve({added:['new.png'],updated:[],unchanged:[],missing:[],errors:[]});await run
    assert.equal(f.state.scanResult.value,null)
    assert.equal(f.state.clips.value[0].filename,'B.png')
    assert.deepEqual(calls,['A','B'])
  }finally{f.dispose()}
})

test('unregister confirmation retains the pool named in the question',async()=>{
  const confirm=deferred<boolean>();const deleted:string[]=[]
  const f=await mount({deletePool:async(id:string)=>{deleted.push(id)}})
  try {
    ;(globalThis as any).__brollFixture.ask=()=>confirm.promise
    const run=f.state.confirmDeletePool();f.state.selectedPoolId.value='B';await flush()
    confirm.resolve(true);await run
    assert.deepEqual(deleted,['A'])
    assert.equal(f.state.selectedPoolId.value,'B')
  }finally{f.dispose()}
})

test('late tag save cannot replace a same-named clip in another pool',async()=>{
  const saved=deferred<any>()
  const f=await mount({listClips:async(id:string)=>({clips:[{filename:'same.png',tags:[id]}]}),setClipTags:()=>saved.promise})
  try {
    const run=f.state.saveTags('same.png',['edited A']);f.state.selectedPoolId.value='B';await flush()
    saved.resolve({filename:'same.png',tags:['edited A']});await run
    assert.deepEqual(f.state.clips.value[0].tags,['B'])
  }finally{f.dispose()}
})

for (const media of ['image', 'audio']) {
  test(`${media} pools cannot queue video normalization`, async()=>{
    const calls:string[]=[]
    const f=await mount({normalizeAll:async()=>{calls.push('all')},normalizeClip:async()=>{calls.push('one')},updatePool:async()=>{calls.push('toggle')}})
    try {
      f.broll.pools.value[0].media=media
      await flush()
      assert.equal(f.state.isVideoPool.value,false)
      assert.equal(f.state.unnormalizedCount.value,0)
      await f.state.runNormalizeAll();await f.state.normalizeOne('A.png');await f.state.toggleAutoNormalize()
      assert.deepEqual(calls,[])
    }finally{f.dispose()}
  })
}

test('refreshing clips after a finished job keeps the grid on screen', async()=>{
  const later=deferred<any>();let calls=0
  const f=await mount({listClips:async()=>(++calls===1?{clips:[{filename:'A.png'}]}:later.promise)})
  try {
    const run=f.state.loadClips();await nextTick()
    assert.equal(f.state.clipsLoading.value,false,'no "Loading clips…" while clips are shown')
    assert.equal(f.state.clips.value[0].filename,'A.png')
    later.resolve({clips:[{filename:'A.png',normalized:true}]});await run
    assert.equal(f.state.clips.value[0].normalized,true)
  }finally{f.dispose()}
})

test('Normalize all asks first, naming how many clips', async()=>{
  const calls:string[]=[];const asked:any[]=[]
  const f=await mount({listClips:async()=>({clips:[{filename:'a.mp4'},{filename:'b.mp4'}]}),normalizeAll:async()=>{calls.push('all');return {queued:2}}})
  try {
    ;(globalThis as any).__brollFixture.ask=async(o:any)=>{asked.push(o);return false}
    await f.state.runNormalizeAll()
    assert.match(asked[0].title,/Normalize 2 clips/)
    assert.deepEqual(calls,[])
    ;(globalThis as any).__brollFixture.ask=async()=>true
    await f.state.runNormalizeAll()
    assert.deepEqual(calls,['all'])
  }finally{f.dispose()}
})

test('large pools render 120 clips at a time and can be filtered', async()=>{
  const many=Array.from({length:300},(_,i)=>({filename:`clip${i}.mp4`,tags:i===250?['sunrise']:[]}))
  const f=await mount({listClips:async()=>({clips:many})})
  try {
    assert.equal(f.state.shownClips.value.length,120)
    f.state.clipLimit.value+=120;await flush()
    assert.equal(f.state.shownClips.value.length,240)
    f.state.clipFilter.value='sunrise';await flush()
    assert.deepEqual(f.state.shownClips.value.map((c:any)=>c.filename),['clip250.mp4'])
  }finally{f.dispose()}
})
