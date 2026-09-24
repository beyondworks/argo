// apk-installer — Android 전용, 스토어 미발행 단계에서만 쓴다. GitHub 릴리스 APK를 앱이 직접 받아 sha256을 대조한 뒤
// FileProvider content:// URI로 설치 화면(PackageInstaller)을 띄운다. 같은 서명(디버그 키)으로 겹쳐 설치되므로
// 데이터·로그인은 유지된다. 다운로드·설치는 메인 스레드를 막지 않도록 별도 스레드에서 수행한다.
package com.beyondworks.argo.messenger.apkinstaller

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

// 응답을 서빙할 수 있는 곳만 따라간다 — 릴리스 API가 변조돼 엉뚱한 곳으로 리다이렉트해도 여기서 막는다(JS 쪽 검사와 이중 방어).
private val ALLOWED_HOSTS = setOf("github.com", "api.github.com", "objects.githubusercontent.com")
private const val MAX_REDIRECTS = 5

@InvokeArg
class DownloadArgs {
    lateinit var url: String
    var sha256: String? = null
    lateinit var onEvent: Channel
}

@TauriPlugin
class ApkInstallerPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun downloadAndInstall(invoke: Invoke) {
        val args = try { invoke.parseArgs(DownloadArgs::class.java) } catch (ex: Exception) { invoke.reject(ex.message, "BAD_ARGS"); return }
        Thread {
            try {
                val file = downloadToCache(args.url, args.onEvent)
                if (args.sha256 != null && !sha256Of(file).equals(args.sha256, ignoreCase = true)) {
                    file.delete()
                    invoke.reject("downloaded file does not match the expected sha256", "SHA256_MISMATCH")
                    return@Thread
                }
                if (!canRequestInstalls()) {
                    invoke.reject("unknown-app install permission is not granted", "PERMISSION_REQUIRED")
                    return@Thread
                }
                startInstall(file)
                val result = JSObject(); result.put("ok", true)
                invoke.resolve(result)
            } catch (ex: Exception) {
                invoke.reject(ex.message ?: "download failed", "DOWNLOAD_FAILED", ex)
            }
        }.start()
    }

    @Command
    fun openUnknownSourcesSettings(invoke: Invoke) {
        try {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
            } else {
                Intent(Settings.ACTION_SECURITY_SETTINGS)
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.applicationContext.startActivity(intent)
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject(ex.message, "SETTINGS_FAILED", ex)
        }
    }

    private fun canRequestInstalls(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

    /** url을 직접 열지 않고 302를 손으로 따라간다 — 매 홉의 호스트를 허용 목록과 대조한다. */
    private fun downloadToCache(startUrl: String, onEvent: Channel): File {
        var current = URL(startUrl)
        var conn: HttpURLConnection
        var redirects = 0
        while (true) {
            if (current.host !in ALLOWED_HOSTS) throw SecurityException("host not allowed: ${current.host}")
            conn = current.openConnection() as HttpURLConnection
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.connect()
            val code = conn.responseCode
            if (code in 300..399) {
                val location = conn.getHeaderField("Location") ?: throw java.io.IOException("redirect without Location")
                conn.disconnect()
                redirects++
                if (redirects > MAX_REDIRECTS) throw java.io.IOException("too many redirects")
                current = URL(current, location)
                continue
            }
            if (code !in 200..299) throw java.io.IOException("download failed: HTTP $code")
            break
        }
        val total = conn.contentLengthLong
        val dir = File(activity.cacheDir, "updates"); dir.mkdirs()
        val out = File(dir, "update.apk")
        var downloaded = 0L
        var lastReportedPct = -1
        conn.inputStream.use { input ->
            out.outputStream().use { output ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    output.write(buf, 0, n)
                    downloaded += n
                    if (total > 0) {
                        val pct = ((downloaded * 100) / total).toInt()
                        if (pct != lastReportedPct) {
                            lastReportedPct = pct
                            val ev = JSObject(); ev.put("progress", downloaded.toDouble() / total.toDouble())
                            onEvent.send(ev)
                        }
                    }
                }
            }
        }
        conn.disconnect()
        return out
    }

    private fun sha256Of(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) { val n = input.read(buf); if (n < 0) break; digest.update(buf, 0, n) }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun startInstall(file: File) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
        intent.setDataAndType(uri, "application/vnd.android.package-archive")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        activity.applicationContext.startActivity(intent)
    }
}
