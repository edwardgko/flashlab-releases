package com.flashlab.app;

import android.app.Activity;
import android.app.Application;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

public class FlashLabApplication extends Application {
    public static final String CHAT_CHANNEL_ID = "flashlab_messages_v2";
    public static final String LEGACY_CHANNEL_ID = "flashlab_messages";
    public static final String FALLBACK_CHANNEL_ID = "fcm_fallback_notification_channel";
    private static int resumedActivityCount = 0;

    public static boolean isAppInForeground() {
        return resumedActivityCount > 0;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();

        registerActivityLifecycleCallbacks(new ActivityLifecycleCallbacks() {
            @Override
            public void onActivityResumed(Activity activity) {
                resumedActivityCount++;
            }

            @Override
            public void onActivityPaused(Activity activity) {
                resumedActivityCount = Math.max(0, resumedActivityCount - 1);
            }

            @Override public void onActivityCreated(Activity activity, Bundle savedInstanceState) {}
            @Override public void onActivityStarted(Activity activity) {}
            @Override public void onActivityStopped(Activity activity) {}
            @Override public void onActivitySaveInstanceState(Activity activity, Bundle outState) {}
            @Override public void onActivityDestroyed(Activity activity) {}
        });
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

            // 1. Canal principal v2 para mensajes de chat (alta importancia para heads-up banner y sonido)
            NotificationChannel chatChannelV2 = new NotificationChannel(
                CHAT_CHANNEL_ID,
                "Mensajes de chat",
                NotificationManager.IMPORTANCE_HIGH
            );
            chatChannelV2.setDescription("Notificaciones de mensajes y menciones de FlashLab");
            chatChannelV2.enableLights(true);
            chatChannelV2.setLightColor(Color.BLUE);
            chatChannelV2.enableVibration(true);
            chatChannelV2.setVibrationPattern(new long[]{ 0, 250, 250, 250 });
            chatChannelV2.setSound(defaultSoundUri, audioAttributes);
            chatChannelV2.setShowBadge(true);
            chatChannelV2.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            manager.createNotificationChannel(chatChannelV2);

            // 2. Canal legacy
            NotificationChannel chatChannelLegacy = new NotificationChannel(
                LEGACY_CHANNEL_ID,
                "Mensajes de chat (antiguo)",
                NotificationManager.IMPORTANCE_HIGH
            );
            chatChannelLegacy.setDescription("Notificaciones de mensajes de FlashLab");
            chatChannelLegacy.enableLights(true);
            chatChannelLegacy.setLightColor(Color.BLUE);
            chatChannelLegacy.enableVibration(true);
            chatChannelLegacy.setVibrationPattern(new long[]{ 0, 250, 250, 250 });
            chatChannelLegacy.setSound(defaultSoundUri, audioAttributes);
            chatChannelLegacy.setShowBadge(true);
            chatChannelLegacy.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            manager.createNotificationChannel(chatChannelLegacy);

            // 3. Canal fallback para FCM
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
