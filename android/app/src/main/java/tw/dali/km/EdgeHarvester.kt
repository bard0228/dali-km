package tw.dali.km

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.util.Base64
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URLEncoder
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

data class NativeSettings(
    val openrouterApiKey: String,
    val geminiApiKey: String,
    val aiProvider: String,
    val geminiModel: String,
    val githubPat: String,
    val githubOwner: String,
    val githubRepo: String,
    val githubBranch: String
)

object EdgeHarvester {
    private const val OPENROUTER_MODEL = "openrouter/free"
    private const val DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"
    private const val CHROME_UA =
        "Mozilla/5.0 (Linux; Android 15; Pixel 10 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"

    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .writeTimeout(180, TimeUnit.SECONDS)
        .build()

    @Volatile
    private var ytdlReady = false

    @Volatile
    private var ytdlUpdated = false

    @Synchronized
    fun ensureInitialized(context: Context) {
        if (!ytdlReady) {
            YoutubeDL.getInstance().init(context.applicationContext)
            FFmpeg.getInstance().init(context.applicationContext)
            ytdlReady = true
        }
        if (!ytdlUpdated) {
            ytdlUpdated = true
            try {
                YoutubeDL.getInstance().updateYoutubeDL(
                    context.applicationContext,
                    YoutubeDL.UpdateChannel._STABLE
                )
            } catch (_: Exception) {
                // Ignore update failures (e.g. offline or rate limit) and continue
            }
        }
    }

    fun cancel(processId: String?) {
        if (!processId.isNullOrBlank()) {
            try {
                YoutubeDL.getInstance().destroyProcessById(processId)
            } catch (_: Exception) {
            }
            for (call in http.dispatcher.queuedCalls()) {
                if (call.request().tag() == processId) call.cancel()
            }
            for (call in http.dispatcher.runningCalls()) {
                if (call.request().tag() == processId) call.cancel()
            }
        }
    }

    private fun checkCancelled(cancelled: AtomicBoolean) {
        if (cancelled.get() || Thread.currentThread().isInterrupted) {
            throw CancellationException("使用者已手動停止分析。")
        }
    }

    fun processUrl(
        context: Context,
        settings: NativeSettings,
        payloadJson: String,
        processId: String,
        cancelled: AtomicBoolean,
        onProgress: (stage: String, message: String) -> Unit
    ) {
        val geminiKey = settings.geminiApiKey.trim()
        val openrouterKey = settings.openrouterApiKey.trim()

        val payload = JSONObject(payloadJson)
        val sourceType = payload.optString("source_type", "youtube")
        val sourceUrl = payload.optString("source_url", "").trim()
        val userSummary = payload.optString("user_summary", "").trim()
        val customTitle = payload.optString("title", "").trim()
        val detailLevel = payload.optString("detail_level", "detailed")
        val tagsArr = payload.optJSONArray("tags") ?: JSONArray()

        val aiProvider = payload.optString("ai_provider", settings.aiProvider)
            .ifBlank { settings.aiProvider }
            .ifBlank { "gemini" }
        val geminiModel = payload.optString("gemini_model", settings.geminiModel)
            .ifBlank { settings.geminiModel }
            .ifBlank { DEFAULT_GEMINI_MODEL }

        if (aiProvider == "openrouter") {
            if (openrouterKey.isBlank()) {
                onProgress("error", "請先在「04 設定」填入 OpenRouter API Key！")
                return
            }
        } else {
            if (geminiKey.isBlank()) {
                onProgress("error", "請先在「04 設定」填入 Gemini API Key！")
                return
            }
        }

        if (settings.githubPat.isBlank() || settings.githubOwner.isBlank()) {
            onProgress("error", "請先在「04 設定」填入 GitHub PAT 與帳號！")
            return
        }

        val workDir = File(context.cacheDir, "harvester_${System.currentTimeMillis()}").apply { mkdirs() }
        try {
            checkCancelled(cancelled)

            val tz = TimeZone.getTimeZone("Asia/Taipei")
            val now = Date()
            val noteId = generateNoteId(sourceUrl, now, tz)
            val monthDir = SimpleDateFormat("yyyy-MM", Locale.US).apply { timeZone = tz }.format(now)
            val createdAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'+08:00'", Locale.US)
                .apply { timeZone = tz }
                .format(now)

            // 1. 3-Layer subtitle extraction: (A) Direct Watch HTML, (B) InnerTube Android API, (C) yt-dlp
            var subtitleText = ""
            var scrapedTitle = ""
            val videoId = extractYoutubeVideoId(sourceUrl)
            if (videoId != null) {
                onProgress("fetching", "正在直連擷取 YouTube 字幕與影片資訊...")
                val direct = tryFetchYoutubeCaptionsDirect(videoId, processId)
                subtitleText = direct.first
                scrapedTitle = direct.second
                checkCancelled(cancelled)
            }

            if (subtitleText.isBlank()) {
                onProgress("fetching", "初始化手機端 yt-dlp 與 FFmpeg 引擎嘗試擷取字幕...")
                ensureInitialized(context)
                checkCancelled(cancelled)
                subtitleText = tryExtractSubtitlesYtDlp(sourceUrl, workDir, processId)
                checkCancelled(cancelled)
            }

            val oembedTitle = scrapedTitle.ifBlank { fetchYoutubeOembedTitle(sourceUrl, processId) }
            checkCancelled(cancelled)

            val structured: JSONObject
            var keyFrames = JSONArray()

            if (subtitleText.isNotBlank()) {
                val engineLabel = if (aiProvider == "openrouter") {
                    "OpenRouter ($OPENROUTER_MODEL)"
                } else {
                    "Gemini ($geminiModel)"
                }
                onProgress("gemini", "已取得字幕，使用 $engineLabel 進行結構化分析...")
                structured = if (aiProvider == "openrouter") {
                    analyzeTextWithOpenRouter(
                        transcriptText = subtitleText,
                        titleHint = customTitle.ifBlank { oembedTitle },
                        apiKey = openrouterKey,
                        userSummary = userSummary,
                        detailLevel = detailLevel,
                        processId = processId
                    )
                } else {
                    analyzeTextWithGemini(
                        transcriptText = subtitleText,
                        titleHint = customTitle.ifBlank { oembedTitle },
                        apiKey = geminiKey,
                        model = geminiModel,
                        userSummary = userSummary,
                        detailLevel = detailLevel,
                        processId = processId
                    )
                }
            } else {
                // 2. Fallback: download video + Gemini multimodal analysis
                if (geminiKey.isBlank()) {
                    throw IllegalStateException("此影片無公開字幕，需使用 Gemini API 下載影片進行多模態分析，請先在「04 設定」填入 Gemini API Key。")
                }
                onProgress("downloading", "此影片無公開字幕，改用手機端下載影片（<=480p）...")
                ensureInitialized(context)
                checkCancelled(cancelled)
                val videoFile = downloadVideoWithYtDlp(sourceUrl, workDir, processId)
                    ?: throw IllegalStateException("無法下載影片，請確認連結是否有效或是否需要登入。")

                checkCancelled(cancelled)
                onProgress("gemini", "上傳影片至 Gemini ($geminiModel) 進行多模態聽覺+視覺分析...")
                val fileUri = uploadToGeminiFileApi(videoFile, geminiKey, processId, cancelled)
                checkCancelled(cancelled)
                structured = analyzeMediaWithGemini(
                    fileUri = fileUri,
                    apiKey = geminiKey,
                    model = geminiModel,
                    userSummary = userSummary,
                    detailLevel = detailLevel,
                    processId = processId
                )

                checkCancelled(cancelled)
                onProgress("keyframes", "依 AI 時間戳在本機擷取重點畫面...")
                val keyPoints = structured.optJSONArray("key_points") ?: JSONArray()
                keyFrames = extractKeyFrames(videoFile, keyPoints, workDir, noteId, monthDir)
            }

            checkCancelled(cancelled)
            onProgress("uploading", "正在同步筆記與素材至 GitHub Vault...")
            val rawAssets = JSONArray()
            for (i in 0 until keyFrames.length()) {
                checkCancelled(cancelled)
                val kf = keyFrames.getJSONObject(i)
                val localFile = File(kf.getString("_local_path"))
                val repoAssetPath = "assets/$monthDir/${localFile.name}"
                putGitHubFile(
                    settings = settings,
                    repoPath = repoAssetPath,
                    bytes = localFile.readBytes(),
                    commitMsg = "feat(edge): add keyframe ${localFile.name}",
                    processId = processId
                )
                rawAssets.put(kf.getString("image_path"))
                kf.remove("_local_path")
            }

            val finalTitle = customTitle
                .ifBlank { structured.optString("title", "") }
                .ifBlank { oembedTitle }
                .ifBlank { "手機端影音筆記" }
            val finalCat = structured.optString("category", "影音筆記").ifBlank { "影音筆記" }
            val mergedTags = mergeTags(tagsArr, structured.optJSONArray("tags"))

            val noteMd = buildStructuredMarkdown(
                noteId = noteId,
                title = finalTitle,
                sourceType = sourceType,
                category = finalCat,
                tags = mergedTags,
                sourceUrl = sourceUrl,
                rawAssets = rawAssets,
                userSummary = userSummary,
                createdAt = createdAt,
                structured = structured,
                keyFrames = keyFrames
            )

            checkCancelled(cancelled)
            putGitHubFile(
                settings = settings,
                repoPath = "notes/$noteId.md",
                bytes = noteMd.toByteArray(Charsets.UTF_8),
                commitMsg = "feat(edge): ingest $noteId via Android Edge Harvester",
                processId = processId
            )

            triggerRebuildIndex(settings, processId)
            val kfNote = if (keyFrames.length() > 0) "與 ${keyFrames.length()} 張重點畫面" else ""
            onProgress("done", "完成！筆記「$finalTitle」$kfNote 已同步至知識庫。")
        } catch (ce: CancellationException) {
            onProgress("cancelled", ce.message ?: "使用者已手動停止分析。")
        } catch (e: Exception) {
            if (cancelled.get()) {
                onProgress("cancelled", "使用者已手動停止分析。")
            } else {
                onProgress("error", "手機端處理失敗：${e.message ?: "未知錯誤"}")
            }
        } finally {
            workDir.deleteRecursively()
        }
    }

    private fun extractYoutubeVideoId(url: String): String? {
        val patterns = listOf(
            Regex("""(?:youtube\.com/watch\?.*?v=|youtu\.be/|youtube\.com/shorts/|youtube\.com/live/|youtube\.com/embed/)([A-Za-z0-9_-]{11})""")
        )
        for (p in patterns) {
            val m = p.find(url)
            if (m != null) return m.groupValues[1]
        }
        return null
    }

    private fun tryFetchYoutubeCaptionsDirect(videoId: String, processId: String): Pair<String, String> {
        // Layer 1: Watch page ytInitialPlayerResponse
        try {
            val req = Request.Builder()
                .url("https://www.youtube.com/watch?v=$videoId&hl=zh-TW")
                .addHeader("User-Agent", CHROME_UA)
                .addHeader("Accept-Language", "zh-TW,zh;q=0.9,en;q=0.8")
                .tag(processId)
                .get()
                .build()
            val html = http.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) resp.body?.string() ?: "" else ""
            }
            val playerJson = extractBalancedJsonAfterMarker(html, "ytInitialPlayerResponse = ")
                ?: extractBalancedJsonAfterMarker(html, "\"ytInitialPlayerResponse\":")
            if (playerJson != null) {
                val res = parseCaptionsFromPlayerJson(playerJson, processId)
                if (res.first.isNotBlank()) return res
                val titleOnly = res.second
                // Layer 2 fallback even if title was found
                val innerRes = tryFetchYoutubeCaptionsInnerTube(videoId, processId)
                if (innerRes.first.isNotBlank()) {
                    return Pair(innerRes.first, innerRes.second.ifBlank { titleOnly })
                }
                if (titleOnly.isNotBlank()) return Pair("", titleOnly)
            }
        } catch (_: Exception) {
        }

        // Layer 2: InnerTube ANDROID client
        return tryFetchYoutubeCaptionsInnerTube(videoId, processId)
    }

    private fun tryFetchYoutubeCaptionsInnerTube(videoId: String, processId: String): Pair<String, String> {
        return try {
            val body = JSONObject()
                .put("videoId", videoId)
                .put(
                    "context",
                    JSONObject().put(
                        "client",
                        JSONObject()
                            .put("clientName", "ANDROID")
                            .put("clientVersion", "20.10.38")
                            .put("hl", "zh-TW")
                            .put("gl", "TW")
                    )
                )
            val req = Request.Builder()
                .url("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
                .addHeader("User-Agent", "com.google.android.youtube/20.10.38 (Linux; U; Android 15; zh_TW)")
                .addHeader("Content-Type", "application/json")
                .tag(processId)
                .post(body.toString().toRequestBody("application/json".toMediaType()))
                .build()
            val jsonStr = http.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) resp.body?.string() ?: "" else ""
            }
            if (jsonStr.isBlank()) return Pair("", "")
            parseCaptionsFromPlayerJson(JSONObject(jsonStr), processId)
        } catch (_: Exception) {
            Pair("", "")
        }
    }

    private fun extractBalancedJsonAfterMarker(source: String, marker: String): JSONObject? {
        val idx = source.indexOf(marker)
        if (idx < 0) return null
        val start = source.indexOf('{', idx + marker.length)
        if (start < 0) return null
        var depth = 0
        var inString = false
        var escape = false
        for (i in start until source.length) {
            val c = source[i]
            if (inString) {
                if (escape) {
                    escape = false
                } else if (c == '\\') {
                    escape = true
                } else if (c == '"') {
                    inString = false
                }
            } else {
                when (c) {
                    '"' -> inString = true
                    '{' -> depth++
                    '}' -> {
                        depth--
                        if (depth == 0) {
                            return try {
                                JSONObject(source.substring(start, i + 1))
                            } catch (_: Exception) {
                                null
                            }
                        }
                    }
                }
            }
        }
        return null
    }

    private fun parseCaptionsFromPlayerJson(player: JSONObject, processId: String): Pair<String, String> {
        val title = player.optJSONObject("videoDetails")?.optString("title", "")?.trim() ?: ""
        val tracks = player.optJSONObject("captions")
            ?.optJSONObject("playerCaptionsTracklistRenderer")
            ?.optJSONArray("captionTracks")
            ?: return Pair("", title)
        if (tracks.length() == 0) return Pair("", title)

        val preferred = listOf("zh-TW", "zh-Hant", "zh-HK", "zh-Hans", "zh", "en", "en-US", "ja")
        var chosenBaseUrl = ""
        for (lang in preferred) {
            for (i in 0 until tracks.length()) {
                val t = tracks.getJSONObject(i)
                val code = t.optString("languageCode", "")
                if (code.equals(lang, ignoreCase = true) || code.startsWith("$lang-", ignoreCase = true)) {
                    chosenBaseUrl = t.optString("baseUrl", "")
                    if (chosenBaseUrl.isNotBlank()) break
                }
            }
            if (chosenBaseUrl.isNotBlank()) break
        }
        if (chosenBaseUrl.isBlank()) {
            chosenBaseUrl = tracks.getJSONObject(0).optString("baseUrl", "")
        }
        if (chosenBaseUrl.isBlank()) return Pair("", title)

        // Try json3 first, then raw XML
        val json3Url = if (chosenBaseUrl.contains("fmt=")) chosenBaseUrl else "$chosenBaseUrl&fmt=json3"
        try {
            val req = Request.Builder()
                .url(json3Url)
                .addHeader("User-Agent", CHROME_UA)
                .tag(processId)
                .get()
                .build()
            val raw = http.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) resp.body?.string() ?: "" else ""
            }
            val parsed = parseJson3String(raw)
            if (parsed.isNotBlank()) return Pair(parsed, title)
        } catch (_: Exception) {
        }

        // Fallback to timedtext XML
        try {
            val req = Request.Builder()
                .url(chosenBaseUrl)
                .addHeader("User-Agent", CHROME_UA)
                .tag(processId)
                .get()
                .build()
            val xml = http.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) resp.body?.string() ?: "" else ""
            }
            val parsed = parseCaptionXmlString(xml)
            if (parsed.isNotBlank()) return Pair(parsed, title)
        } catch (_: Exception) {
        }

        return Pair("", title)
    }

    private fun fetchYoutubeOembedTitle(url: String, processId: String): String {
        if (!url.contains("youtube.com") && !url.contains("youtu.be")) return ""
        return try {
            val encoded = URLEncoder.encode(url, "UTF-8")
            val req = Request.Builder()
                .url("https://www.youtube.com/oembed?url=$encoded&format=json")
                .tag(processId)
                .get()
                .build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return ""
                val body = resp.body?.string() ?: return ""
                JSONObject(body).optString("title", "").trim()
            }
        } catch (_: Exception) {
            ""
        }
    }

    private fun tryExtractSubtitlesYtDlp(url: String, outDir: File, processId: String): String {
        return try {
            val req = YoutubeDLRequest(url).apply {
                addOption("--no-playlist")
                addOption("--no-cache-dir")
                addOption("--retries", "3")
                addOption("--socket-timeout", "15")
                addOption("--js-runtimes", "quickjs")
                addOption("--skip-download")
                addOption("--write-subs")
                addOption("--write-auto-subs")
                addOption("--sub-langs", "zh-TW,zh-Hant,zh-HK,zh-Hans,zh,en,en-US,ja")
                addOption("--sub-format", "json3/vtt/srt/srv3/best")
                addOption("-o", File(outDir, "sub.%(ext)s").absolutePath)
            }
            YoutubeDL.getInstance().execute(req, processId, null)
            val subFiles = outDir.listFiles()?.filter { it.isFile && it.length() > 40 } ?: emptyList()
            for (f in subFiles) {
                val text = when {
                    f.name.endsWith(".json3", true) -> parseJson3String(f.readText(Charsets.UTF_8))
                    f.name.endsWith(".vtt", true) || f.name.endsWith(".srt", true) -> parseVttOrSrtString(f.readText(Charsets.UTF_8))
                    f.name.endsWith(".srv3", true) || f.name.endsWith(".xml", true) -> parseCaptionXmlString(f.readText(Charsets.UTF_8))
                    else -> ""
                }
                if (text.isNotBlank()) return text
            }
            ""
        } catch (_: Exception) {
            ""
        }
    }

    private fun parseJson3String(raw: String): String {
        if (!raw.trimStart().startsWith("{")) return ""
        return try {
            val root = JSONObject(raw)
            val events = root.optJSONArray("events") ?: return ""
            val sb = StringBuilder()
            for (i in 0 until events.length()) {
                val ev = events.getJSONObject(i)
                val segs = ev.optJSONArray("segs") ?: continue
                val line = buildString {
                    for (j in 0 until segs.length()) {
                        append(segs.getJSONObject(j).optString("utf8", ""))
                    }
                }.replace("\n", " ").trim()
                if (line.isBlank()) continue
                val ms = ev.optLong("tStartMs", 0L)
                val totalSec = (ms / 1000L).toInt()
                sb.append(String.format(Locale.US, "[%02d:%02d] %s\n", totalSec / 60, totalSec % 60, line))
                if (sb.length > 45_000) break
            }
            sb.toString().trim()
        } catch (_: Exception) {
            ""
        }
    }

    private fun parseCaptionXmlString(xml: String): String {
        if (!xml.contains("<text")) return ""
        return try {
            val rx = Regex("""<text[^>]*start="([0-9.]+)"[^>]*>(.*?)</text>""", RegexOption.DOT_MATCHES_ALL)
            val sb = StringBuilder()
            for (m in rx.findAll(xml)) {
                val sec = m.groupValues[1].toDoubleOrNull()?.toInt() ?: 0
                val text = unescapeHtml(m.groupValues[2].replace(Regex("<[^>]+>"), " ")).replace(Regex("\\s+"), " ").trim()
                if (text.isBlank()) continue
                sb.append(String.format(Locale.US, "[%02d:%02d] %s\n", sec / 60, sec % 60, text))
                if (sb.length > 45_000) break
            }
            sb.toString().trim()
        } catch (_: Exception) {
            ""
        }
    }

    private fun parseVttOrSrtString(raw: String): String {
        val sb = StringBuilder()
        var currentTs = "00:00"
        val tsRx = Regex("""(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,]\d{3}\s*-->""")
        for (line in raw.lines()) {
            val trimmed = line.trim()
            if (trimmed.isBlank() || trimmed == "WEBVTT" || trimmed.startsWith("Kind:") || trimmed.startsWith("Language:")) continue
            if (trimmed.all { it.isDigit() }) continue
            val m = tsRx.find(trimmed)
            if (m != null) {
                val hh = m.groupValues[1].toIntOrNull() ?: 0
                val mm = m.groupValues[2].toIntOrNull() ?: 0
                val ss = m.groupValues[3].toIntOrNull() ?: 0
                val totalMm = hh * 60 + mm
                currentTs = String.format(Locale.US, "%02d:%02d", totalMm, ss)
                continue
            }
            val clean = unescapeHtml(trimmed.replace(Regex("<[^>]+>"), "")).trim()
            if (clean.isNotBlank()) {
                sb.append("[$currentTs] $clean\n")
                if (sb.length > 45_000) break
            }
        }
        return sb.toString().trim()
    }

    private fun unescapeHtml(s: String): String =
        s.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&apos;", "'")
            .replace("\n", " ")

    private fun downloadVideoWithYtDlp(url: String, outDir: File, processId: String): File? {
        val req = YoutubeDLRequest(url).apply {
            addOption("--no-playlist")
            addOption("--no-cache-dir")
            addOption("--retries", "3")
            addOption("--socket-timeout", "20")
            addOption("--js-runtimes", "quickjs")
            addOption("--extractor-args", "youtube:player_client=tv,ios,android")
            addOption("-f", "best[ext=mp4][height<=480]/best[height<=480]/best")
            addOption("--max-filesize", "45M")
            addOption("-o", File(outDir, "media.%(ext)s").absolutePath)
        }
        YoutubeDL.getInstance().execute(req, processId, null)
        return outDir.listFiles()?.firstOrNull {
            it.isFile && it.length() > 1024 && it.extension.lowercase() in setOf("mp4", "mkv", "webm", "m4a")
        }
    }

    private fun buildTextAnalysisPrompt(
        transcriptText: String,
        titleHint: String,
        userSummary: String,
        detailLevel: String
    ): String {
        val countHint = if (detailLevel == "detailed") "10 到 20 條" else "5 到 8 條"
        return """
            你是專業的繁體中文（台灣用語）知識庫影音分析助理。
            請根據以下影片字幕逐字稿，產出完整結構化筆記。
            影片標題提示：${titleHint.ifBlank { "未提供" }}
            使用者備忘：${userSummary.ifBlank { "無" }}
            嚴格輸出單一 JSON 物件（不要有 markdown 圍欄），欄位如下：
            {
              "title": "精簡繁體中文標題",
              "one_line_summary": "一句話核心結論（40字以內）",
              "category": "分類（如 AI科技、投資理財、影音筆記、生活健康）",
              "tags": ["標籤1", "標籤2", "標籤3"],
              "limited_note": "",
              "key_points": [
                {"section": "段落名稱", "point": "精煉重點", "detail": "1~3句補充說明", "timestamp": "MM:SS"}
              ],
              "key_info": [{"label": "關鍵數據/工具/人名", "value": "內容"}],
              "transcript": [{"t": "MM:SS", "s": "", "x": "重點逐字稿片段（繁體中文）"}]
            }
            要求：key_points 請列出 $countHint 並附正確 timestamp（MM:SS）。
            
            === 影片字幕 ===
            $transcriptText
        """.trimIndent()
    }

    private fun formatGeminiError(prefix: String, code: Int, body: String, apiKey: String): String {
        val trimmedKey = apiKey.trim()
        val apiMsg = try {
            JSONObject(body).optJSONObject("error")?.optString("message", "") ?: ""
        } catch (_: Exception) {
            ""
        }
        if ((code == 401 || code == 403 || code == 400) && trimmedKey.startsWith("AQ.")) {
            return "$prefix HTTP $code：您填入的 `AQ.` 開頭金鑰屬於 Google Cloud Express 金鑰，AI Studio Gemini API (`generativelanguage.googleapis.com`) 不接受此格式。請至 https://aistudio.google.com/apikey 取得 `AIza` 開頭的免費 API Key 後重新儲存「04 設定」。"
        }
        if (code == 401) {
            return "$prefix HTTP 401（金鑰驗證未通過）：${apiMsg.ifBlank { "請檢查「04 設定」的 Gemini API Key 是否為 aistudio.google.com/apikey 核發之 AIza 開頭金鑰，且前後無多餘空白。" }}"
        }
        return "$prefix HTTP $code${if (apiMsg.isNotBlank()) "：$apiMsg" else ": ${body.take(200)}"}"
    }

    private fun analyzeTextWithGemini(
        transcriptText: String,
        titleHint: String,
        apiKey: String,
        model: String,
        userSummary: String,
        detailLevel: String,
        processId: String
    ): JSONObject {
        val key = apiKey.trim()
        val prompt = buildTextAnalysisPrompt(transcriptText, titleHint, userSummary, detailLevel)
        val body = JSONObject().put(
            "contents",
            JSONArray().put(
                JSONObject().put(
                    "parts",
                    JSONArray().put(JSONObject().put("text", prompt))
                )
            )
        ).put(
            "generationConfig",
            JSONObject()
                .put("temperature", 0.2)
                .put("responseMimeType", "application/json")
        )

        val req = Request.Builder()
            .url("https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent")
            .addHeader("x-goog-api-key", key)
            .tag(processId)
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(req).execute().use { resp ->
            val raw = resp.body?.string() ?: ""
            if (!resp.isSuccessful) {
                throw IllegalStateException(formatGeminiError("Gemini ($model) 分析失敗", resp.code, raw, key))
            }
            val text = JSONObject(raw)
                .getJSONArray("candidates")
                .getJSONObject(0)
                .getJSONObject("content")
                .getJSONArray("parts")
                .getJSONObject(0)
                .getString("text")
            return parseJsonLenient(text)
        }
    }

    private fun analyzeTextWithOpenRouter(
        transcriptText: String,
        titleHint: String,
        apiKey: String,
        userSummary: String,
        detailLevel: String,
        processId: String
    ): JSONObject {
        val prompt = buildTextAnalysisPrompt(transcriptText, titleHint, userSummary, detailLevel)
        val body = JSONObject()
            .put("model", OPENROUTER_MODEL)
            .put("temperature", 0.2)
            .put(
                "messages",
                JSONArray().put(
                    JSONObject()
                        .put("role", "user")
                        .put("content", prompt)
                )
            )

        val req = Request.Builder()
            .url("https://openrouter.ai/api/v1/chat/completions")
            .addHeader("Authorization", "Bearer ${apiKey.trim()}")
            .addHeader("HTTP-Referer", "https://bard0228.github.io/dali-km/")
            .addHeader("X-Title", "Dali KM Edge Harvester")
            .tag(processId)
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(req).execute().use { resp ->
            val raw = resp.body?.string() ?: ""
            if (!resp.isSuccessful) throw IllegalStateException("OpenRouter 分析失敗 HTTP ${resp.code}: ${raw.take(220)}")
            val content = JSONObject(raw)
                .getJSONArray("choices")
                .getJSONObject(0)
                .getJSONObject("message")
                .getString("content")
            return parseJsonLenient(content)
        }
    }

    private fun parseJsonLenient(raw: String): JSONObject {
        val cleaned = raw.trim()
            .removePrefix("```json")
            .removePrefix("```")
            .removeSuffix("```")
            .trim()
        val start = cleaned.indexOf('{')
        val end = cleaned.lastIndexOf('}')
        val slice = if (start >= 0 && end > start) cleaned.substring(start, end + 1) else cleaned
        return JSONObject(slice)
    }

    private fun uploadToGeminiFileApi(
        file: File,
        apiKey: String,
        processId: String,
        cancelled: AtomicBoolean
    ): String {
        val key = apiKey.trim()
        val mime = if (file.extension.equals("m4a", true)) "audio/mp4" else "video/mp4"
        val startBody = JSONObject().put("file", JSONObject().put("display_name", file.name)).toString()
        val startReq = Request.Builder()
            .url("https://generativelanguage.googleapis.com/upload/v1beta/files")
            .addHeader("x-goog-api-key", key)
            .addHeader("X-Goog-Upload-Protocol", "resumable")
            .addHeader("X-Goog-Upload-Command", "start")
            .addHeader("X-Goog-Upload-Header-Content-Length", file.length().toString())
            .addHeader("X-Goog-Upload-Header-Content-Type", mime)
            .tag(processId)
            .post(startBody.toRequestBody("application/json".toMediaType()))
            .build()

        val uploadUrl = http.newCall(startReq).execute().use { resp ->
            val raw = resp.body?.string() ?: ""
            if (!resp.isSuccessful) {
                throw IllegalStateException(formatGeminiError("Gemini upload start", resp.code, raw, key))
            }
            resp.header("X-Goog-Upload-URL") ?: throw IllegalStateException("Missing X-Goog-Upload-URL")
        }

        checkCancelled(cancelled)
        val upReq = Request.Builder()
            .url(uploadUrl)
            .addHeader("x-goog-api-key", key)
            .addHeader("X-Goog-Upload-Offset", "0")
            .addHeader("X-Goog-Upload-Command", "upload, finalize")
            .tag(processId)
            .post(file.asRequestBody(mime.toMediaType()))
            .build()

        var fileUri = ""
        var fileName = ""
        var state = "ACTIVE"
        http.newCall(upReq).execute().use { resp ->
            val raw = resp.body?.string() ?: ""
            if (!resp.isSuccessful) {
                throw IllegalStateException(formatGeminiError("Gemini upload", resp.code, raw, key))
            }
            val fObj = JSONObject(raw).getJSONObject("file")
            fileUri = fObj.getString("uri")
            fileName = fObj.getString("name")
            state = fObj.optString("state", "ACTIVE")
        }

        val deadline = System.currentTimeMillis() + 180_000
        while (state == "PROCESSING" && System.currentTimeMillis() < deadline) {
            checkCancelled(cancelled)
            Thread.sleep(2500)
            val stReq = Request.Builder()
                .url("https://generativelanguage.googleapis.com/v1beta/$fileName")
                .addHeader("x-goog-api-key", key)
                .tag(processId)
                .get()
                .build()
            http.newCall(stReq).execute().use { resp ->
                if (resp.isSuccessful) {
                    val info = JSONObject(resp.body?.string() ?: "{}")
                    state = info.optString("state", state)
                    if (state == "FAILED") throw IllegalStateException("Gemini 影片處理失敗")
                }
            }
        }
        return fileUri
    }

    private fun analyzeMediaWithGemini(
        fileUri: String,
        apiKey: String,
        model: String,
        userSummary: String,
        detailLevel: String,
        processId: String
    ): JSONObject {
        val key = apiKey.trim()
        val countHint = if (detailLevel == "detailed") "10 到 20 條" else "5 到 8 條"
        val prompt = """
            你是專業的繁體中文（台灣用語）知識庫影音分析助理。
            請聽這部影片的語音並觀察畫面上的重要文字，產出完整結構化筆記。
            使用者備忘：${userSummary.ifBlank { "無" }}
            嚴格輸出單一 JSON 物件，欄位如下：
            {
              "title": "精簡繁體中文標題",
              "one_line_summary": "一句話核心結論（40字以內）",
              "category": "分類（如 AI科技、投資理財、影音筆記、生活健康）",
              "tags": ["標籤1", "標籤2", "標籤3"],
              "limited_note": "",
              "key_points": [
                {"section": "段落名稱", "point": "精煉重點", "detail": "1~3句補充說明", "timestamp": "MM:SS"}
              ],
              "key_info": [{"label": "關鍵數據/工具/人名", "value": "內容"}],
              "transcript": [{"t": "MM:SS", "s": "", "x": "逐字稿內容（繁體中文或原語言）"}]
            }
            要求：key_points 請列出 $countHint 並附正確 timestamp（MM:SS）。
        """.trimIndent()

        val body = JSONObject().put(
            "contents",
            JSONArray().put(
                JSONObject().put(
                    "parts",
                    JSONArray()
                        .put(
                            JSONObject().put(
                                "file_data",
                                JSONObject().put("mime_type", "video/mp4").put("file_uri", fileUri)
                            )
                        )
                        .put(JSONObject().put("text", prompt))
                )
            )
        ).put(
            "generationConfig",
            JSONObject()
                .put("temperature", 0.2)
                .put("responseMimeType", "application/json")
        )

        val req = Request.Builder()
            .url("https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent")
            .addHeader("x-goog-api-key", key)
            .tag(processId)
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(req).execute().use { resp ->
            val raw = resp.body?.string() ?: ""
            if (!resp.isSuccessful) {
                throw IllegalStateException(formatGeminiError("Gemini ($model) 分析失敗", resp.code, raw, key))
            }
            val text = JSONObject(raw)
                .getJSONArray("candidates")
                .getJSONObject(0)
                .getJSONObject("content")
                .getJSONArray("parts")
                .getJSONObject(0)
                .getString("text")
            return parseJsonLenient(text)
        }
    }

    private fun extractKeyFrames(
        videoFile: File,
        keyPoints: JSONArray,
        workDir: File,
        noteId: String,
        monthDir: String
    ): JSONArray {
        val result = JSONArray()
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(videoFile.absolutePath)
            val seenSecs = mutableListOf<Int>()
            for (i in 0 until keyPoints.length()) {
                if (result.length() >= 6) break
                val kp = keyPoints.getJSONObject(i)
                val ts = kp.optString("timestamp", "").trim()
                val sec = parseTimestampSeconds(ts) ?: continue
                if (seenSecs.any { kotlin.math.abs(it - sec) < 4 }) continue

                val bmp = retriever.getFrameAtTime(sec * 1_000_000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                    ?: continue
                val outFile = File(workDir, "${noteId}_kf_${result.length() + 1}.jpg")
                ByteArrayOutputStream().use { bos ->
                    bmp.compress(Bitmap.CompressFormat.JPEG, 85, bos)
                    outFile.writeBytes(bos.toByteArray())
                }
                bmp.recycle()
                seenSecs.add(sec)
                result.put(
                    JSONObject()
                        .put("timestamp", ts)
                        .put("caption", kp.optString("point", ""))
                        .put("image_path", "../assets/$monthDir/${outFile.name}")
                        .put("_local_path", outFile.absolutePath)
                )
            }
        } catch (_: Exception) {
        } finally {
            retriever.release()
        }
        return result
    }

    private fun parseTimestampSeconds(ts: String): Int? {
        val parts = ts.split(":").mapNotNull { it.trim().toIntOrNull() }
        return when (parts.size) {
            2 -> parts[0] * 60 + parts[1]
            3 -> parts[0] * 3600 + parts[1] * 60 + parts[2]
            else -> null
        }
    }

    private fun putGitHubFile(
        settings: NativeSettings,
        repoPath: String,
        bytes: ByteArray,
        commitMsg: String,
        processId: String
    ) {
        val url = "https://api.github.com/repos/${settings.githubOwner}/${settings.githubRepo}/contents/$repoPath"
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val body = JSONObject()
            .put("message", commitMsg)
            .put("content", b64)
            .put("branch", settings.githubBranch)

        val req = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer ${settings.githubPat}")
            .addHeader("Accept", "application/vnd.github+json")
            .tag(processId)
            .put(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw IllegalStateException("GitHub 上傳失敗 HTTP ${resp.code}: ${resp.body?.string()}")
            }
        }
    }

    private fun triggerRebuildIndex(settings: NativeSettings, processId: String) {
        val url = "https://api.github.com/repos/${settings.githubOwner}/${settings.githubRepo}/actions/workflows/ingest.yml/dispatches"
        val body = JSONObject().put("ref", settings.githubBranch)
        val req = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer ${settings.githubPat}")
            .addHeader("Accept", "application/vnd.github+json")
            .tag(processId)
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        try {
            http.newCall(req).execute().close()
        } catch (_: Exception) {
        }
    }

    private fun generateNoteId(seed: String, now: Date, tz: TimeZone): String {
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).apply { timeZone = tz }.format(now)
        val md = MessageDigest.getInstance("SHA-1").digest("$seed:$stamp".toByteArray())
        val hex = md.take(3).joinToString("") { "%02x".format(it) }
        return "$stamp-$hex"
    }

    private fun mergeTags(userTags: JSONArray, aiTags: JSONArray?): List<String> {
        val out = mutableListOf<String>()
        for (i in 0 until userTags.length()) {
            val t = userTags.optString(i).trim()
            if (t.isNotEmpty() && t !in out) out.add(t)
        }
        if (aiTags != null) {
            for (i in 0 until aiTags.length()) {
                val t = aiTags.optString(i).trim()
                if (t.isNotEmpty() && t !in out) out.add(t)
            }
        }
        if (out.isEmpty()) out.add("影音筆記")
        return out
    }

    private fun buildStructuredMarkdown(
        noteId: String,
        title: String,
        sourceType: String,
        category: String,
        tags: List<String>,
        sourceUrl: String,
        rawAssets: JSONArray,
        userSummary: String,
        createdAt: String,
        structured: JSONObject,
        keyFrames: JSONArray
    ): String {
        val tagsYaml = tags.joinToString("\n") { "- $it" }
        val assetsYaml = if (rawAssets.length() == 0) "[]" else {
            "\n" + (0 until rawAssets.length()).joinToString("\n") { "- ${rawAssets.getString(it)}" }
        }
        val sb = StringBuilder()
        sb.append("---\n")
        sb.append("id: $noteId\n")
        sb.append("title: \"${title.replace("\"", "\\\"")}\"\n")
        sb.append("source_type: $sourceType\n")
        sb.append("status: completed\n")
        sb.append("category: $category\n")
        sb.append("tags:\n$tagsYaml\n")
        sb.append("source_url: $sourceUrl\n")
        sb.append("raw_assets: $assetsYaml\n")
        sb.append("user_summary: \"${userSummary.replace("\"", "\\\"")}\"\n")
        sb.append("created_at: '$createdAt'\n")
        sb.append("---\n\n")

        if (userSummary.isNotBlank()) {
            sb.append("## 使用者初步重點\n\n$userSummary\n\n")
        }

        val oneLine = structured.optString("one_line_summary", "")
        sb.append("## AI 結構化摘要\n\n")
        if (oneLine.isNotBlank()) sb.append("> **一句話結論**：$oneLine\n\n")
        val kps = structured.optJSONArray("key_points") ?: JSONArray()
        for (i in 0 until kps.length()) {
            val kp = kps.getJSONObject(i)
            val ts = kp.optString("timestamp", "")
            val pt = kp.optString("point", "")
            val dt = kp.optString("detail", "")
            sb.append("- ${if (ts.isNotBlank()) "**[$ts]** " else ""}$pt\n")
            if (dt.isNotBlank()) sb.append("  - $dt\n")
        }

        val payload = JSONObject()
            .put("schema_version", 2)
            .put("one_line_summary", oneLine)
            .put("limited_note", structured.optString("limited_note", ""))
            .put("key_points", kps)
            .put("key_info", structured.optJSONArray("key_info") ?: JSONArray())
            .put("key_frames", keyFrames)
            .put("transcript", structured.optJSONArray("transcript") ?: JSONArray())
            .put("fact_check", JSONObject())

        sb.append("\n<!-- DALI_STRUCTURED_JSON\n${payload.toString(2)}\n-->\n")
        return sb.toString()
    }
}
