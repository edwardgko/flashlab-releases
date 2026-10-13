package com.flashlab.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.HashMap;
import java.util.Map;

public class FlashLabMessagingService extends FirebaseMessagingService {

    private static final String TAG = "FlashLabMessaging";
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

        // el push nuevo es solo-data; un push viejo con `notification` (función
        // desplegada anterior) trae título/cuerpo ahí — se normaliza a data
        Map<String, String> data = new HashMap<>(remoteMessage.getData());
        if (remoteMessage.getNotification() != null) {
            if (!data.containsKey("title")) data.put("title", remoteMessage.getNotification().getTitle());
            if (!data.containsKey("body")) data.put("body", remoteMessage.getNotification().getBody());
        }

        // 2. Si el mensaje lo envié yo mismo, NUNCA notificar a este dispositivo
        String senderId = data.get("senderId");
        String activeUserId = getActiveUserId(this);
        if (senderId != null && activeUserId != null && senderId.equals(activeUserId)) {
            Log.d(TAG, "Mensaje ignorado porque fue enviado por el usuario activo: " + senderId);
            return;
        }

        // 3. Chat silenciado desde la notificación (hasta reactivarlo en la app)
        String chatKey = data.get("chatKey");
        if (ChatNotifications.isMuted(this, chatKey)) return;

        // 4. Con la app abierta solo se calla si estás leyendo ESE chat; en
        // cualquier otra pantalla (o minimizada/cerrada) sale la notificación
        if (FlashLabApplication.isAppInForeground() && chatKey != null && chatKey.equals(ChatNotifications.getViewingChat())) {
            return;
        }

        try {
            ChatNotifications.show(this, data);
        } catch (Throwable t) {
            Log.e(TAG, "Fallo al mostrar notificación nativa", t);
        }
    }

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        try {
            PushNotificationsPlugin.onNewToken(token);
        } catch (Exception ignored) {}
    }
}
