package com.flashlab.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import androidx.core.app.RemoteInput;
import org.json.JSONObject;

// Botones de la notificación de chat (ver ChatNotifications.show):
// Silenciar es local; Responder y Marcar como leído van a la edge function
// send-chat-push con el token de acción del push (funciona con la app cerrada).
public class NotificationActionReceiver extends BroadcastReceiver {
    private static final String TAG = "FlashLabNotifAction";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        String chatKey = intent.getStringExtra(ChatNotifications.EXTRA_CHAT_KEY);
        if (action == null || chatKey == null || chatKey.isEmpty()) return;
        Context appContext = context.getApplicationContext();

        if (ChatNotifications.ACTION_MUTE.equals(action)) {
            ChatNotifications.setMuted(appContext, chatKey, true);
            ChatNotifications.cancel(appContext, chatKey);
            return;
        }

        String userId = intent.getStringExtra(ChatNotifications.EXTRA_USER_ID);
        String token = intent.getStringExtra(ChatNotifications.EXTRA_ACTION_TOKEN);
        String replyText = null;
        if (ChatNotifications.ACTION_REPLY.equals(action)) {
            Bundle results = RemoteInput.getResultsFromIntent(intent);
            CharSequence text = results != null ? results.getCharSequence(ChatNotifications.REPLY_KEY) : null;
            replyText = text != null ? text.toString().trim() : "";
            if (replyText.isEmpty()) {
                ChatNotifications.cancel(appContext, chatKey);
                return;
            }
        } else if (ChatNotifications.ACTION_MARK_READ.equals(action)) {
            ChatNotifications.cancel(appContext, chatKey);
        } else {
            return;
        }

        final String text = replyText;
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                JSONObject payload = new JSONObject()
                    .put("action", "notification_action")
                    .put("type", text != null ? "reply" : "mark_read")
                    .put("userId", userId)
                    .put("chatKey", chatKey)
                    .put("token", token);
                if (text != null) payload.put("text", text);
                boolean ok = ChatNotifications.postAction(appContext, payload);
                if (text != null) {
                    if (ok) ChatNotifications.cancel(appContext, chatKey);
                    else ChatNotifications.markReplyFailed(appContext, chatKey);
                }
            } catch (Exception e) {
                Log.w(TAG, "falló la acción " + action, e);
                if (text != null) ChatNotifications.markReplyFailed(appContext, chatKey);
            } finally {
                pending.finish();
            }
        }).start();
    }
}
