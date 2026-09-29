// OpenClaw 2026.8.1+ 진입점(루트 `openclaw/plugin-sdk`가 없어진 버전부터). 채널 등록·런타임 주입은 defineChannelPluginEntry가 맡는다.
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { argoApprovalToolFactory, argoMsgrPlugin, attachCronService, detachCronService, setArgoRuntime, setPluginVersion } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "openclaw-argo-msgr",  // 플러그인 id = 디렉터리 이름(오픈클로가 대조한다). 채널 id는 argo-msgr
  name: "Argo Messenger",
  description: "Argo Messenger channel plugin — OpenClaw joins a company's Argo Messenger as a bot",
  plugin: argoMsgrPlugin,
  setRuntime: setArgoRuntime,
  registerFull: (api) => {
    // 크루 계약 1-b ①: 메신저에 보고할 어댑터 버전(api.version = 매니페스트 version → package.json version)
    setPluginVersion((api as any).version);
    // 크루 계약 1-a: 게이트웨이 서비스만 스케줄러 핸들(ctx.getCron — list/update/remove)을 받는다. 예약 작업 미러·편집은 이 핸들로만 한다.
    api.registerService({ id: "argo-msgr-routines", start: (ctx) => attachCronService(ctx), stop: () => detachCronService() });
    // 크루 계약 1-b ④: 에이전트가 올리는 결재 도구. 팩토리가 argo-msgr 대화가 아니면 null을 돌려 다른 채널에서는 숨긴다(선택 도구 아님).
    // openclaw.plugin.json contracts.tools에 같은 이름을 선언한다.
    api.registerTool(argoApprovalToolFactory, { name: "argo_request_approval" });
  },
});
