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
import java.util.concurrent.atomic.AtomicBoolean

// 응답을 서빙할 수 있는 곳만 따라간다 — 릴리스 API가 변조돼 엉뚱한 곳으로 리다이렉트해도 여기서 막는다(JS 쪽 검사와 이중 방어).
// release-assets.githubusercontent.com은 실측(2026-09-24, `curl -I -H "Accept: application/octet-stream"`)으로 확인한
// 실제 302 리다이렉트 목적지 — objects.githubusercontent.com이 아니다.
private val ALLOWED_HOSTS = setOf("github.com", "api.github.com", "release-assets.githubusercontent.com")
private const val MAX_REDIRECTS = 5
// 시작 URL은 이 접두사로 고정한다 — JS가 무엇을 보내든 "api.github.com의 이 레포 자산 id" 모양이 아니면 시작하지 않는다.
private const val REQUIRED_URL_PREFIX = "https://api.github.com/repos/beyondworks/argo-messenger/releases/assets/"

@InvokeArg
class DownloadArgs {
    lateinit var url: String
    var sha256: String? = null
    lateinit var onEvent: Channel
}

@TauriPlugin
class ApkInstallerPlugin(private val activity: Activity) : Plugin(activity) {
    // 연속 두 번 눌러도(더블탭) 다운로드는 한 번만 — 두 번째 호출은 즉시 거부한다.
    private val downloading = AtomicBoolean(false)

    @Command
    fun downloadAndInstall(invoke: Invoke) {
        val args = try { invoke.parseArgs(DownloadArgs::class.java) } catch (ex: Exception) { invoke.reject(ex.message, "BAD_ARGS"); return }
        if (args.sha256.isNullOrBlank()) { invoke.reject("release asset has no sha256 digest — refusing to install unverifiable APK", "SHA256_REQUIRED"); return }
        if (!args.url.startsWith(REQUIRED_URL_PREFIX)) { invoke.reject("asset url must start with $REQUIRED_URL_PREFIX", "BAD_ARGS"); return }
        // 설치 권한 확인을 다운로드보다 먼저 — 권한이 없으면 굳이 수십MB를 받지 않는다.
        if (!canRequestInstalls()) { invoke.reject("unknown-app install permission is not granted", "PERMISSION_REQUIRED"); return }
        if (!downloading.compareAndSet(false, true)) { invoke.reject("a download is already in progress", "ALREADY_DOWNLOADING"); return }
        Thread {
            try {
                val file = downloadToCache(args.url, args.sha256!!, args.onEvent)
                startInstall(file)
                cleanupOtherDownloads(file)
                val result = JSObject(); result.put("ok", true)
                invoke.resolve(result)
            } catch (ex: SecurityException) {
                invoke.reject(ex.message, "HOST_NOT_ALLOWED", ex)
            } catch (ex: Exception) {
                invoke.reject(ex.message ?: "download failed", "DOWNLOAD_FAILED", ex)
            } finally {
                downloading.set(false)
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

    /** url을 직접 열지 않고 302를 손으로 따라간다 — 매 홉의 호스트를 허용 목록과 대조하고, https만 따라간다.
     *  받은 뒤 sha256을 대조한다(불일치면 파일을 지우고 거부). 파일명은 매 호출마다 고유하게 — 겹쳐 쓰다 반쯤 받은
     *  파일을 설치하려 드는 경합을 없앤다. */
    private fun downloadToCache(startUrl: String, expectedSha256: String, onEvent: Channel): File {
        var current = URL(startUrl)
        var conn: HttpURLConnection
        var redirects = 0
        while (true) {
            if (current.protocol != "https") throw SecurityException("only https is followed: ${current.protocol}")
            if (current.host !in ALLOWED_HOSTS) throw SecurityException("host not allowed: ${current.host}")
            conn = current.openConnection() as HttpURLConnection
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            // api.github.com의 자산 엔드포인트는 이 헤더 없이는 JSON 메타데이터를 돌려준다(바이너리가 아니다) — 302로만 실제 파일을 받는다.
            conn.setRequestProperty("Accept", "application/octet-stream")
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
        val out = File(dir, "update-${System.currentTimeMillis()}.apk")
        var downloaded = 0L
        var lastReportedPct = -1
        val digest = MessageDigest.getInstance("SHA-256")
        conn.inputStream.use { input ->
            out.outputStream().use { output ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    output.write(buf, 0, n)
                    digest.update(buf, 0, n)
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
        val actual = digest.digest().joinToString("") { "%02x".format(it) }
        if (!actual.equals(expectedSha256, ignoreCase = true)) {
            out.delete()
            throw SecurityException("downloaded file does not match the expected sha256")
        }
        return out
    }

    /** 방금 받은 파일만 남기고 updates/ 아래 이전 다운로드를 지운다(설치 화면을 연 뒤 — 설치 전에 지우면 인텐트가 가리키는 파일이 없어진다). */
    private fun cleanupOtherDownloads(keep: File) {
        keep.parentFile?.listFiles()?.forEach { f -> if (f.name != keep.name) f.delete() }
    }

    private fun startInstall(file: File) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
        intent.setDataAndType(uri, "application/vnd.android.package-archive")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        activity.applicationContext.startActivity(intent)
    }
}
