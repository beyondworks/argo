// notif-tray — Android 전용. 런처 아이콘 숫자·점은 트레이에 남은 알림에서 나온다. 앱 안에서 읽어도 FCM이 띄운 알림은 남아
// 숫자가 안 사라졌다(유건 제보 2026-10-01). JS가 아직 안 읽은 채널의 태그(keep)를 보내면 그 밖의 메시지 알림을 지운다.
// 메시지 알림 태그 = 엣지 msgr-push의 group(`ch-<채널>`) — 같은 칸이 한 채널의 알림을 하나로 묶는다(FCM 알림 id는 0).
package com.beyondworks.argo.messenger.notiftray

import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val MESSAGE_TAG_PREFIX = "ch-"

@InvokeArg
class ClearArgs {
    var keep: List<String> = emptyList()
}

@TauriPlugin
class NotifTrayPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun clearRead(invoke: Invoke) {
        val args = try { invoke.parseArgs(ClearArgs::class.java) } catch (ex: Exception) { invoke.reject(ex.message, "BAD_ARGS"); return }
        val keep = args.keep.toHashSet()
        val nm = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        var cleared = 0
        try {
            // 이 앱이 띄운 알림만 돌려준다(API 23+, minSdk 24). 신고 알림(report-…) 등 다른 태그는 남긴다.
            for (sbn in nm.activeNotifications) {
                val tag = sbn.tag ?: continue
                if (!tag.startsWith(MESSAGE_TAG_PREFIX) || tag in keep) continue
                nm.cancel(tag, sbn.id)
                cleared++
            }
        } catch (ex: Exception) { invoke.reject(ex.message, "TRAY_FAILED"); return }
        val result = JSObject(); result.put("cleared", cleared)
        invoke.resolve(result)
    }
}
