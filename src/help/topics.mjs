// 도움말 주제 목록 — src/help/index.mjs가 검색한다. 주제 하나 = 파일 하나(src/help/topics/<id>.mjs).
import deck from './topics/deck.mjs';
import assistant from './topics/assistant.mjs';
import agentSettings from './topics/agent-settings.mjs';
import agents from './topics/agents.mjs';
import chat from './topics/chat.mjs';
import room from './topics/room.mjs';
import compete from './topics/compete.mjs';
import mail from './topics/mail.mjs';
import activity from './topics/activity.mjs';
import memory from './topics/memory.mjs';
import routines from './topics/routines.mjs';
import approvals from './topics/approvals.mjs';
import market from './topics/market.mjs';
import runners from './topics/runners.mjs';
import settings from './topics/settings.mjs';
import sync from './topics/sync.mjs';
import messenger from './topics/messenger.mjs';
import plan from './topics/plan.mjs';

export const TOPICS = Object.freeze([deck, agents, chat, room, compete, mail, activity, memory, routines, assistant, approvals, market, runners, settings, sync, messenger, plan, agentSettings]);
