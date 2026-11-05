import {chromium} from '/Users/likht.ethan/.t3/worktrees/breezer/t3-4523f995/tests/ai/node_modules/playwright/index.mjs';
import {readFile,writeFile} from 'node:fs/promises';
const base='/tmp/breezer-ui-polish',output=base+'/round-17-final-native';const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{const page=await browser.newPage();const images=[];for(const mode of ['normal','reduced'])for(const ms of [0,100,300,600,900,1200,1500,1800]){const path=base+`/round-17-final-native${mode==='reduced'?'-reduced':''}/native-motion-${ms}.png`;images.push({mode,ms,path,png:(await readFile(path)).toString('base64')});}
const results=await page.evaluate(async images=>{
 const c=document.createElement('canvas'),ctx=c.getContext('2d',{willReadFrequently:true});
 const load=async png=>{const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();c.width=image.width;c.height=image.height;ctx.drawImage(image,0,0);};
 const l=(p,i)=>(p[i]+p[i+1]+p[i+2])/3;
 await load(images.find(x=>x.mode==='reduced'&&x.ms===0).png);
 const ref=ctx.getImageData(1374,14,40,40).data,refBackground=l(ref,0),pattern=Array.from({length:1600},(_,i)=>Math.abs(l(ref,i*4)-refBackground));
 const mask=pattern.flatMap((v,i)=>v>80?[i]:[]);if(mask.length<20||mask.length>500)throw Error('Inspect reference glyph');
 const results=[];
 for(const im of images){await load(im.png);const band=ctx.getImageData(900,10,560,50).data;let best={rmse:Infinity};
  for(let centerX=950;centerX<=1410;centerX++)for(let dy=-3;dy<=3;dy++){
   const x=centerX-20-900,y=4+dy,bg=l(band,(y*560+x)*4);let squared=0,stroke=0;
   for(let py=0;py<40;py++)for(let px=0;px<40;px++){const idx=py*40+px,actual=Math.abs(l(band,((y+py)*560+x+px)*4)-bg);squared+=(actual-pattern[idx])**2;}
   const rmse=Math.sqrt(squared/1600);
   if(rmse<best.rmse){stroke=mask.reduce((sum,i)=>sum+Math.abs(l(band,((y+Math.floor(i/40))*560+x+i%40)*4)-bg),0)/mask.length;best={rmse,strokeSeparation:stroke,center:{x:centerX,y:34+dy}};}
  }
  results.push({mode:im.mode,ms:im.ms,path:im.path,templateStrokePixels:mask.length,...best,visibleInSample:best.rmse<18&&best.strokeSeparation>50});
 }
 return results;
},images);
await writeFile(output+'/native-plus-samples.json',JSON.stringify({method:'Full 40x40 plus-glyph shape matching across the tab-strip movement range, including surrounding background to reject text, favicons and close buttons. These are decoded samples, not continuous visibility, input latency or frame pacing.',results},null,2));console.log(JSON.stringify(results.map(({mode,ms,visibleInSample,center,rmse})=>({mode,ms,visibleInSample,center,rmse:Number(rmse.toFixed(2))}))));if(results.some(x=>!x.visibleInSample))throw Error('Inspect unmatched native plus sample');
}finally{await browser.close();}
