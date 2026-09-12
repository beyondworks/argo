import { mergeConfig } from 'vite';
import { execFileSync } from 'node:child_process';
import fixture from './dm-lifecycle.config.mjs';
export default mergeConfig(fixture, {
 plugins:[{name:'mobile-scroll-baseline',enforce:'pre',load(id){
  if(process.env.SCROLL_BASELINE_REF && id.endsWith('/src/styles.css'))return execFileSync('git',['show',`${process.env.SCROLL_BASELINE_REF}:apps/messenger/src/styles.css`],{encoding:'utf8'});
 }}],
 server:{port:Number(process.env.SCROLL_TEST_PORT||5208),strictPort:true}
});
