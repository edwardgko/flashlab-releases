package com.capacitorjs.plugins.pushnotifications;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.flashlab.app.FlashLabApplication;
import com.flashlab.app.FlashLabMessagingService;
import com.flashlab.app.MainActivity;
import com.flashlab.app.R;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public class MessagingService extends FirebaseMessagingService {

    private static final String TAG = "FlashLabMessaging";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);

        // 1. Avisar al plugin de Capacitor por si la webview está viva
        try {
            PushNotificationsPlugin.sendRemoteMessage(remoteMessage);
        } catch (Exception ignored) {}

        // 2. Extraer datos
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
        String activeUserId = FlashLabMessagingService.getActiveUserId(this);

        // 3. Si el mensaje lo envié yo mismo, no notificar
        if (senderId != null && activeUserId != null && senderId.equals(activeUserId)) {
            Log.d(TAG, "Mensaje ignorado porque fue enviado por el usuario activo: " + senderId);
            return;
        }

        // 4. Si la app NO está visible en primer plano, mostrar la notificación nativa
        boolean isForeground = FlashLabApplication.isAppInForeground();
        if (!isForeground) {
            showNativeNotification(title, body, data);
        }
    }

    private Bitmap getLargeIconBitmap() {
        try {
            Drawable drawable = ContextCompat.getDrawable(this, R.mipmap.ic_launcher);
            if (drawable == null) return null;
            if (drawable instanceof BitmapDrawable) {
                return ((BitmapDrawable) drawable).getBitmap();
            }
            int width = drawable.getIntrinsicWidth() > 0 ? drawable.getIntrinsicWidth() : 96;
            int height = drawable.getIntrinsicHeight() > 0 ? drawable.getIntrinsicHeight() : 96;
            Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            drawable.setBounds(0, 0, canvas.getWidth(), canvas.getHeight());
            drawable.draw(canvas);
            return bitmap;
        } catch (Throwable t) {
            return null;
        }
    }

    private void showNativeNotification(String title, String body, Map<String, String> data) {
        try {
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
                .setSmallIcon(R.drawable.ic_stat_notification)
                .setColor(ContextCompat.getColor(this, R.color.notification_color))
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

            Bitmap largeIcon = getLargeIconBitmap();
            if (largeIcon != null) {
                builder.setLargeIcon(largeIcon);
            }

            int notifId = (int) (System.currentTimeMillis() % 10000000);
            notificationManager.notify(notifId, builder.build());
            Log.d(TAG, "Notificación nativa lanzada con éxito: " + notifId);
        } catch (Throwable t) {
            Log.e(TAG, "Fallo al mostrar notificación nativa", t);
        }
    }

    @Override
    public void onNewToken(@NonNull String s) {
        super.onNewToken(s);
        try {
            PushNotificationsPlugin.onNewToken(s);
        } catch (Exception ignored) {}
    }
}
