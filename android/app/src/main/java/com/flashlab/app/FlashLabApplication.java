package com.flashlab.app;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

public class FlashLabApplication extends Application {
    public static final String CHAT_CHANNEL_ID = "flashlab_messages";
    public static final String FALLBACK_CHANNEL_ID = "fcm_fallback_notification_channel";

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
    }

    public void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager == null) return;

            Uri defaultSoundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
                .build();

            // 1. Canal principal para mensajes de chat (alta importancia para heads-up banner y sonido)
            NotificationChannel chatChannel = new NotificationChannel(
                CHAT_CHANNEL_ID,
                "Mensajes de chat",
                NotificationManager.IMPORTANCE_HIGH
            );
            chatChannel.setDescription("Notificaciones de mensajes y menciones de FlashLab");
            chatChannel.enableLights(true);
            chatChannel.setLightColor(Color.BLUE);
            chatChannel.enableVibration(true);
            chatChannel.setVibrationPattern(new long[]{ 0, 250, 250, 250 });
            chatChannel.setSound(defaultSoundUri, audioAttributes);
            chatChannel.setShowBadge(true);
            chatChannel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            manager.createNotificationChannel(chatChannel);

            // 2. Canal fallback para FCM
            NotificationChannel fallbackChannel = new NotificationChannel(
                FALLBACK_CHANNEL_ID,
                "Notificaciones generales",
                NotificationManager.IMPORTANCE_HIGH
            );
            fallbackChannel.setDescription("Notificaciones generales de FlashLab");
            fallbackChannel.enableLights(true);
            fallbackChannel.setLightColor(Color.BLUE);
            fallbackChannel.enableVibration(true);
            fallbackChannel.setVibrationPattern(new long[]{ 0, 250, 250, 250 });
            fallbackChannel.setSound(defaultSoundUri, audioAttributes);
            fallbackChannel.setShowBadge(true);
            fallbackChannel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            manager.createNotificationChannel(fallbackChannel);
        }
    }
}
