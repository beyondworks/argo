package com.beyondworks.argo.messenger

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.provider.Settings

class MessengerApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Also runs when FCM wakes a closed app, before Firebase posts its notification.
        createSoundChannels()
    }

    internal fun createSoundChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        val legacy = manager.getNotificationChannel("msgr")
            ?: manager.getNotificationChannel("fcm_fallback_notification_channel")
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val sounds = listOf(
            "seatbelt_single" to R.string.sound_seatbelt_single,
            "seatbelt_hilo" to R.string.sound_seatbelt_hilo,
            "wood_knock" to R.string.sound_wood_knock,
            "wood_knock_double" to R.string.sound_wood_knock_double,
            "wood_marimba" to R.string.sound_wood_marimba,
        )
        for ((resource, label) in sounds) {
            val id = "msgr_sound_$resource"
            // Channels are immutable and belong to the user after creation. Never delete/recreate.
            if (manager.getNotificationChannel(id) != null) continue
            val channel = NotificationChannel(id, getString(label), legacy?.importance ?: NotificationManager.IMPORTANCE_DEFAULT)
            // Use resource names, not numeric IDs which can change on an app update.
            channel.setSound(Uri.parse("android.resource://$packageName/raw/$resource"), attributes)
            if (legacy != null) {
                channel.enableVibration(legacy.shouldVibrate())
                legacy.vibrationPattern?.let { channel.vibrationPattern = it }
                channel.enableLights(legacy.shouldShowLights())
                channel.lightColor = legacy.lightColor
                channel.setShowBadge(legacy.canShowBadge())
                channel.lockscreenVisibility = legacy.lockscreenVisibility
                // Preserve an explicit system-level sound override, including silence.
                val preserveSound = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) legacy.sound == null || legacy.hasUserSetSound()
                    else legacy.sound != Settings.System.DEFAULT_NOTIFICATION_URI
                if (preserveSound) {
                    channel.setSound(legacy.sound, legacy.audioAttributes)
                }
            }
            manager.createNotificationChannel(channel)
        }
    }
}
