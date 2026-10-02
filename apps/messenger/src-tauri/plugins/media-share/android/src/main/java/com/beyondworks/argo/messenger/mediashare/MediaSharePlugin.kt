// media-share — 메신저 첨부 저장·공유(Android, 2026-10-02). 서명 URL을 직접 받아 캐시(cacheDir/media-share)에 원래 이름으로 둔 뒤:
//   share → ACTION_SEND 공유 시트 · open → ACTION_VIEW 앱 선택(맞는 앱이 없으면 선택 창이 알린다)
//   save  → Android 10(API 29)+: MediaStore — 그림은 Pictures/Argo(갤러리), 그 밖은 Download/Argo. 저장 권한이 필요 없다.
//           Android 7~9(API 24~28)는 권한 없이 공용 폴더에 쓸 수 없어 공유 시트로 넘긴다(거기서 '드라이브·파일에 저장').
// FileProvider는 앱 매니페스트의 ${applicationId}.fileprovider(cache-path ".")를 같이 쓴다(apk-installer와 같은 자리).
// 결과: { where: "photos"|"downloads"|"share" } — 실패는 reject(문구는 JS가 고른다). 내려받기는 메인 스레드 밖에서.
package com.beyondworks.argo.messenger.mediashare

import android.app.Activity
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

private const val MAX_BYTES = 26_214_400L // 첨부 상한 25MB(앱·게이트웨이·저장소 정책과 같다)
private const val MAX_REDIRECTS = 3
private const val KEEP_MS = 24 * 60 * 60 * 1000L // 공유 대상 앱이 다 읽을 시간을 두고 하루 뒤 지운다

@InvokeArg
class MediaArgs {
    lateinit var url: String
    var name: String? = null
    var mime: String? = null
}

@TauriPlugin
class MediaSharePlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun share(invoke: Invoke) = work(invoke) { file, mime ->
        startChooser(sendIntent(file, mime))
        JSObject().apply { put("where", "share") }
    }

    @Command
    fun open(invoke: Invoke) = work(invoke) { file, mime ->
        val uri = uriOf(file)
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        view.clipData = ClipData.newRawUri(file.name, uri)
        startChooser(view)
        JSObject().apply { put("where", "open") }
    }

    @Command
    fun save(invoke: Invoke) = work(invoke) { file, mime ->
        val where = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) saveToMediaStore(file, mime) else { startChooser(sendIntent(file, mime)); "share" }
        JSObject().apply { put("where", where) }
    }

    private fun work(invoke: Invoke, block: (File, String) -> JSObject) {
        val args = try { invoke.parseArgs(MediaArgs::class.java) } catch (ex: Exception) { invoke.reject(ex.message, "BAD_ARGS"); return }
        Thread {
            try {
                val (file, mime) = download(args)
                invoke.resolve(block(file, mime))
            } catch (ex: Exception) {
                invoke.reject(ex.message ?: "media failed", "MEDIA_FAILED", ex)
            }
        }.start()
    }

    /** 리다이렉트는 손으로 따라간다(최대 3번, http(s)만). 25MB를 넘으면 받다가 멈춘다. */
    private fun download(args: MediaArgs): Pair<File, String> {
        var current = URL(args.url)
        var conn: HttpURLConnection
        var hops = 0
        while (true) {
            if (current.protocol != "https" && current.protocol != "http") throw SecurityException("only http(s)")
            conn = current.openConnection() as HttpURLConnection
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.connect()
            val code = conn.responseCode
            if (code in 300..399) {
                val location = conn.getHeaderField("Location") ?: throw IOException("redirect without Location")
                conn.disconnect()
                if (++hops > MAX_REDIRECTS) throw IOException("too many redirects")
                current = URL(current, location)
                continue
            }
            if (code !in 200..299) throw IOException("HTTP $code")
            break
        }
        if (conn.contentLengthLong > MAX_BYTES) { conn.disconnect(); throw IOException("file too large") }
        val root = File(activity.cacheDir, "media-share")
        prune(root)
        val dir = File(root, System.nanoTime().toString()).apply { mkdirs() }
        val name = safeName(args.name)
        val out = File(dir, name)
        var total = 0L
        conn.inputStream.use { input ->
            out.outputStream().use { output ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > MAX_BYTES) { dir.deleteRecursively(); throw IOException("file too large") }
                    output.write(buf, 0, n)
                }
            }
        }
        val headerMime = conn.contentType?.substringBefore(';')?.trim().orEmpty()
        conn.disconnect()
        val given = args.mime.orEmpty()
        val mime = when {
            given.isNotBlank() && given != "application/octet-stream" -> given
            headerMime.isNotBlank() && headerMime != "application/octet-stream" -> headerMime
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
        }
        return out to mime
    }

    private fun saveToMediaStore(file: File, mime: String): String {
        val image = mime.startsWith("image/")
        val collection = if (image) MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            else MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, if (image) "${Environment.DIRECTORY_PICTURES}/Argo" else "${Environment.DIRECTORY_DOWNLOADS}/Argo")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val resolver = activity.contentResolver
        val uri = resolver.insert(collection, values) ?: throw IOException("could not create the file")
        try {
            (resolver.openOutputStream(uri) ?: throw IOException("could not open the file")).use { out -> file.inputStream().use { it.copyTo(out) } }
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } catch (ex: Exception) {
            resolver.delete(uri, null, null) // 반쯤 쓴 항목을 갤러리·다운로드에 남기지 않는다
            throw ex
        }
        return if (image) "photos" else "downloads"
    }

    private fun uriOf(file: File) = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)

    private fun sendIntent(file: File, mime: String): Intent {
        val uri = uriOf(file)
        return Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).also { it.clipData = ClipData.newRawUri(file.name, uri) }
    }

    private fun startChooser(target: Intent) {
        val chooser = Intent.createChooser(target, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        activity.runOnUiThread { activity.startActivity(chooser) }
    }

    private fun prune(root: File) {
        val now = System.currentTimeMillis()
        root.listFiles()?.forEach { if (now - it.lastModified() > KEEP_MS) it.deleteRecursively() }
    }

    /** 파일 이름 — 경로 구분자·예약 문자·제어 문자를 '_'로, 앞뒤 점·공백 제거, 120자, 비면 "file" */
    private fun safeName(raw: String?): String {
        val base = (raw ?: "file").substringAfterLast('/').substringAfterLast('\\')
        val cleaned = base.map { c -> if (c.code < 0x20 || c in "<>:\"|?*") '_' else c }.joinToString("").trim('.', ' ')
        return cleaned.take(120).ifEmpty { "file" }
    }
}
