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
import java.util.concurrent.TimeUnit

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
                // Ignore update failures (e.g. offline or rate limit) and continue with current binary
            }
        }
    }

    fun processUrl(
        context: Context,
        settings: NativeSettings,
        payloadJson: String,
        onProgress: (stage: String, message: String) -> Unit
    ) {
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
            if (settings.openrouterApiKey.isBlank()) {
                onProgress("error", "請先在「04 設定」填入 OpenRouter API Key！")
                return
            }
        } else {
            if (settings.geminiApiKey.isBlank()) {
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
            onProgress("fetching", "初始化並更新手機端 yt-dlp 與 FFmpeg 引擎...")
            ensureInitialized(context)

            val tz = TimeZone.getTimeZone("Asia/Taipei")
            val now = Date()
            val noteId = generateNoteId(sourceUrl, now, tz)
            val monthDir = SimpleDateFormat("yyyy-MM", Locale.US).apply { timeZone = tz }.format(now)
            val createdAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'+08:00'", Locale.US)
                .apply { timeZone = tz }
                .format(now)

            // 1. Try lightweight subtitle extraction first (avoids YouTube stream 400/sign-in walls)
            onProgress("fetching", "優先嘗試擷取字幕（tv/ios/android client）...")
            val subtitleText = tryExtractSubtitles(sourceUrl, workDir)
            val oembedTitle = fetchYoutubeOembedTitle(sourceUrl)

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
                        apiKey = settings.openrouterApiKey,
                        userSummary = userSummary,
                        detailLevel = detailLevel
                    )
                } else {
                    analyzeTextWithGemini(
                        transcriptText = subtitleText,
                        titleHint = customTitle.ifBlank { oembedTitle },
                        apiKey = settings.geminiApiKey,
                        model = geminiModel,
                        userSummary = userSummary,
                        detailLevel = detailLevel
                    )
                }
            } else {
                // 2. Fallback to downloading video + Gemini File API multimodal analysis
                if (settings.geminiApiKey.isBlank()) {
                    throw IllegalStateException("此影片無公開字幕，需使用 Gemini API 下載影片進行多模態分析，請先在「04 設定」填入 Gemini API Key。")
                }
                onProgress("downloading", "無可用字幕，使用手機行動網路下載影片（<=480p）...")
                val videoFile = downloadVideoWithYtDlp(sourceUrl, workDir)
                    ?: throw IllegalStateException("無法下載影片，請確認連結是否有效或是否需要登入。")

                onProgress("gemini", "上傳影片至 Gemini ($geminiModel) 進行多模態聽覺+視覺分析...")
                val fileUri = uploadToGeminiFileApi(videoFile, settings.geminiApiKey)
                structured = analyzeMediaWithGemini(
                    fileUri = fileUri,
                    apiKey = settings.geminiApiKey,
                    model = geminiModel,
                    userSummary = userSummary,
                    detailLevel = detailLevel
                )

                onProgress("keyframes", "依 AI 時間戳在本機擷取重點畫面...")
                val keyPoints = structured.optJSONArray("key_points") ?: JSONArray()
                keyFrames = extractKeyFrames(videoFile, keyPoints, workDir, noteId, monthDir)
            }

            onProgress("uploading", "正在同步重點畫面與筆記至 GitHub Vault...")
            val rawAssets = JSONArray()
            for (i in 0 until keyFrames.length()) {
                val kf = keyFrames.getJSONObject(i)
                val localFile = File(kf.getString("_local_path"))
                val repoAssetPath = "assets/$monthDir/${localFile.name}"
                putGitHubFile(
                    settings = settings,
                    repoPath = repoAssetPath,
                    bytes = localFile.readBytes(),
                    commitMsg = "feat(edge): add keyframe ${localFile.name}"
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

            putGitHubFile(
                settings = settings,
                repoPath = "notes/$noteId.md",
                bytes = noteMd.toByteArray(Charsets.UTF_8),
                commitMsg = "feat(edge): ingest $noteId via Android Edge Harvester"
            )

            triggerRebuildIndex(settings)
            val kfNote = if (keyFrames.length() > 0) "與 ${keyFrames.length()} 張重點畫面" else ""
            onProgress("done", "完成！筆記「$finalTitle」$kfNote 已同步至知識庫。")
        } catch (e: Exception) {
            onProgress("error", "手機端處理失敗：${e.message ?: "未知錯誤"}")
        } finally {
            workDir.deleteRecursively()
        }
    }

    private fun fetchYoutubeOembedTitle(url: String): String {
        if (!url.contains("youtube.com") && !url.contains("youtu.be")) return ""
        return try {
            val encoded = URLEncoder.encode(url, "UTF-8")
            val req = Request.Builder()
                .url("https://www.youtube.com/oembed?url=$encoded&format=json")
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

    private fun tryExtractSubtitles(url: String, outDir: File): String {
        return try {
            val req = YoutubeDLRequest(url).apply {
                addOption("--no-playlist")
                addOption("--skip-download")
                addOption("--write-subs")
                addOption("--write-auto-subs")
                addOption("--sub-langs", "zh-TW,zh-Hant,zh-Hans,zh,en,ja")
                addOption("--sub-format", "json3")
                addOption("--extractor-args", "youtube:player_client=tv,ios,android")
                addOption("-o", File(outDir, "sub.%(ext)s").absolutePath)
            }
            YoutubeDL.getInstance().execute(req, null, null)
            val subFile = outDir.listFiles()?.firstOrNull {
                it.isFile && it.name.endsWith(".json3") && it.length() > 50
            } ?: return ""
            parseJson3Subtitles(subFile)
        } catch (_: Exception) {
            ""
        }
    }

    private fun parseJson3Subtitles(file: File): String {
        return try {
            val root = JSONObject(file.readText(Charsets.UTF_8))
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
                val mm = totalSec / 60
                val ss = totalSec % 60
                sb.append(String.format(Locale.US, "[%02d:%02d] %s\n", mm, ss, line))
                if (sb.length > 45_000) break
            }
            sb.toString().trim()
        } catch (_: Exception) {
            ""
        }
    }

    private fun downloadVideoWithYtDlp(url: String, outDir: File): File? {
        val req = YoutubeDLRequest(url).apply {
            addOption("--no-playlist")
            addOption("--extractor-args", "youtube:player_client=tv,ios,android")
            addOption("-f", "best[ext=mp4][height<=480]/best[height<=480]/best")
            addOption("--max-filesize", "45M")
            addOption("-o", File(outDir, "media.%(ext)s").absolutePath)
        }
        YoutubeDL.getInstance().execute(req, null, null)
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

    private fun analyzeTextWithGemini(
        transcriptText: String,
        titleHint: String,
        apiKey: String,
        model: String,
        userSummary: String,
        detailLevel: String
    ): JSONObject {
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
            .url("https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent?key=$apiKey")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(req).execute().use { resp ->
            val raw = resp.body?.string() ?: ""
            if (!resp.isSuccessful) throw IllegalStateException("Gemini ($model) 分析失敗 HTTP ${resp.code}: $raw")
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
        detailLevel: String
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
            .addHeader("Authorization", "Bearer $apiKey")
            .addHeader("HTTP-Referer", "https://bard0228.github.io/dali-km/")
            .addHeader("X-Title", "Dali KM Edge Harvester")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(req).execute().use { resp ->
            val raw = resp.body?.string() ?: ""
            if (!resp.isSuccessful) throw IllegalStateException("OpenRouter 分析失敗 HTTP ${resp.code}: $raw")
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

    private fun uploadToGeminiFileApi(file: File, apiKey: String): String {
        val mime = if (file.extension.equals("m4a", true)) "audio/mp4" else "video/mp4"
        val startBody = JSONObject().put("file", JSONObject().put("display_name", file.name)).toString()
        val startReq = Request.Builder()
            .url("https://generativelanguage.googleapis.com/upload/v1beta/files?key=$apiKey")
            .addHeader("X-Goog-Upload-Protocol", "resumable")
            .addHeader("X-Goog-Upload-Command", "start")
            .addHeader("X-Goog-Upload-Header-Content-Length", file.length().toString())
            .addHeader("X-Goog-Upload-Header-Content-Type", mime)
            .post(startBody.toRequestBody("application/json".toMediaType()))
            .build()

        val uploadUrl = http.newCall(startReq).execute().use { resp ->
            if (!resp.isSuccessful) throw IllegalStateException("Gemini upload start HTTP ${resp.code}")
            resp.header("X-Goog-Upload-URL") ?: throw IllegalStateException("Missing X-Goog-Upload-URL")
        }

        val upReq = Request.Builder()
            .url(uploadUrl)
            .addHeader("X-Goog-Upload-Offset", "0")
            .addHeader("X-Goog-Upload-Command", "upload, finalize")
            .post(file.asRequestBody(mime.toMediaType()))
            .build()

        var fileUri = ""
        var fileName = ""
        var state = "ACTIVE"
        http.newCall(upReq).execute().use { resp ->
            val raw = resp.body?.string() ?: ""
            if (!resp.isSuccessful) throw IllegalStateException("Gemini upload HTTP ${resp.code}: $raw")
            val fObj = JSONObject(raw).getJSONObject("file")
            fileUri = fObj.getString("uri")
            fileName = fObj.getString("name")
            state = fObj.optString("state", "ACTIVE")
        }

        val deadline = System.currentTimeMillis() + 180_000
        while (state == "PROCESSING" && System.currentTimeMillis() < deadline) {
            Thread.sleep(2500)
            val stReq = Request.Builder()
                .url("https://generativelanguage.googleapis.com/v1beta/$fileName?key=$apiKey")
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
        detailLevel: String
    ): JSONObject {
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
            .url("https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent?key=$apiKey")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(req).execute().use { resp ->
            val raw = resp.body?.string() ?: ""
            if (!resp.isSuccessful) throw IllegalStateException("Gemini ($model) 分析失敗 HTTP ${resp.code}: $raw")
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
        commitMsg: String
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
            .put(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw IllegalStateException("GitHub 上傳失敗 HTTP ${resp.code}: ${resp.body?.string()}")
            }
        }
    }

    private fun triggerRebuildIndex(settings: NativeSettings) {
        val url = "https://api.github.com/repos/${settings.githubOwner}/${settings.githubRepo}/actions/workflows/ingest.yml/dispatches"
        val body = JSONObject().put("ref", settings.githubBranch)
        val req = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer ${settings.githubPat}")
            .addHeader("Accept", "application/vnd.github+json")
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
