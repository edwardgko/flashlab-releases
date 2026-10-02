package com.flashlab.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public class FlashLabMessagingService extends FirebaseMessagingService {

    public static final String PREFS_NAME = "FlashLabPrefs";
    public static final String KEY_ACTIVE_USER_ID = "active_user_id";

    public static void setActiveUserId(Context context, String userId) {
        if (context == null) return;
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(KEY_ACTIVE_USER_ID, userId).apply();
    }

    public static String getActiveUserId(Context context) {
        if (context == null) return null;
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getString(KEY_ACTIVE_USER_ID, null);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);

        // 1. Siempre avisar al plugin de Capacitor por si la vista web está activa
        try {
            PushNotificationsPlugin.sendRemoteMessage(remoteMessage);
        } catch (Exception ignored) {}

        // 2. Extraer título, cuerpo y metadatos
        Map<String, String> data = remoteMessage.getData();
        String title = null;
        String body = null;

        if (remoteMessage.getNotification() != null) {
            title = remoteMessage.getNotification().getTitle();
            body = remoteMessage.getNotification().getBody();
        }

        if ((title == null || title.isEmpty()) && data != null && data.containsKey("title")) {
            title = data.get("title");
        }
        if ((body == null || body.isEmpty()) && data != null && data.containsKey("body")) {
            body = data.get("body");
        }
        if (title == null || title.isEmpty()) title = "FlashLab";
        if (body == null || body.isEmpty()) body = "Nuevo mensaje";

        String senderId = data != null ? data.get("senderId") : null;
        String activeUserId = getActiveUserId(this);

        // 3. REGLA FUNDAMENTAL: Si el mensaje lo envié yo mismo, NUNCA notificar a este dispositivo
        if (senderId != null && activeUserId != null && senderId.equals(activeUserId)) {
            return;
        }

        // 4. Si la app está cerrada o en segundo plano, construir y mostrar la notificación nativa
        PushNotificationsPlugin pushPlugin = PushNotificationsPlugin.getPushNotificationsInstance();
        boolean isForeground = (pushPlugin != null && pushPlugin.getActivity() != null && !pushPlugin.getActivity().isFinishing());

        if (!isForeground) {
            showNativeNotification(title, body, data);
        }
    }

    private void showNativeNotification(String title, String body, Map<String, String> data) {
        NotificationManager notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (notificationManager == null) return;

        String channelId = FlashLabApplication.CHAT_CHANNEL_ID;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = notificationManager.getNotificationChannel(channelId);
            if (channel == null) {
                Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
                AudioAttributes audioAttributes = new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
                    .build();

                channel = new NotificationChannel(channelId, "Mensajes de chat", NotificationManager.IMPORTANCE_HIGH);
                channel.setDescription("Notificaciones de mensajes de FlashLab");
                channel.enableLights(true);
                channel.setLightColor(Color.BLUE);
                channel.enableVibration(true);
                channel.setVibrationPattern(new long[]{ 0, 250, 250, 250 });
                channel.setSound(soundUri, audioAttributes);
                channel.setShowBadge(true);
                notificationManager.createNotificationChannel(channel);
            }
        }

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (data != null) {
            for (Map.Entry<String, String> entry : data.entrySet()) {
                intent.putExtra(entry.getKey(), entry.getValue());
            }
        }

        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            (int) System.currentTimeMillis(),
            intent,
            pendingFlags
        );

        Uri defaultSoundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setLargeIcon(BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setSound(defaultSoundUri)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setVibrate(new long[]{ 0, 250, 250, 250 })
            .setContentIntent(pendingIntent);

        int notifId = Math.abs((title + ":" + body).hashCode());
        notificationManager.notify(notifId, builder.build());
    }

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        try {
            PushNotificationsPlugin.onNewToken(token);
        } catch (Exception ignored) {}
    }
}

