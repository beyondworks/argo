// OpenClaw 2026.8.1+ 진입점(루트 `openclaw/plugin-sdk`가 없어진 버전부터). 채널 등록·런타임 주입은 defineChannelPluginEntry가 맡는다.
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { argoMsgrPlugin, attachCronService, detachCronService, setArgoRuntime } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "openclaw-argo-msgr",  // 플러그인 id = 디렉터리 이름(오픈클로가 대조한다). 채널 id는 argo-msgr
  name: "Argo Messenger",
  description: "Argo Messenger channel plugin — OpenClaw joins a company's Argo Messenger as a bot",
  plugin: argoMsgrPlugin,
  setRuntime: setArgoRuntime,
  // 크루 계약 1-a: 게이트웨이 서비스만 스케줄러 핸들(ctx.getCron — list/update/remove)을 받는다. 예약 작업 미러·편집은 이 핸들로만 한다.
  registerFull: (api) => {
    api.registerService({ id: "argo-msgr-routines", start: (ctx) => attachCronService(ctx), stop: () => detachCronService() });
  },
});
