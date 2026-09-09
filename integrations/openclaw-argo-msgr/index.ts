import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { argoMsgrPlugin, setArgoRuntime } from "./src/channel.js";

const plugin = {
  id: "openclaw-argo-msgr",  // 플러그인 id = 디렉터리 이름(오픈클로가 대조한다). 채널 id는 argo-msgr
  name: "Argo Messenger",
  description: "Argo Messenger channel plugin — OpenClaw joins a company's Argo Messenger as a bot",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setArgoRuntime(api.runtime);
    api.registerChannel({ plugin: argoMsgrPlugin as ChannelPlugin });
  },
};
export default plugin;
