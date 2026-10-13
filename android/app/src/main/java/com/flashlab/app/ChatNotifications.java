package com.flashlab.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Shader;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import androidx.core.content.ContextCompat;
import androidx.core.content.LocusIdCompat;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;

// Notificación de chat estilo WhatsApp: foto de quien escribe (la de su cuenta
// de Google; en grupos, la del grupo; si no hay, el logo de FlashLab),
// mensajes acumulados por chat y los botones Responder / Marcar como leído /
// Silenciar en el idioma del teléfono (res/values*/strings.xml).
// La arma siempre este código — el push llega SOLO-DATA (ver
// supabase/functions/send-chat-push), también con la app cerrada.
public final class ChatNotifications {
    private static final String TAG = "FlashLabChatNotif";
    static final String NOTIFICATION_TAG = "chat";

    static final String ACTION_REPLY = "com.flashlab.app.NOTIFICATION_REPLY";
    static final String ACTION_MARK_READ = "com.flashlab.app.NOTIFICATION_MARK_READ";
    static final String ACTION_MUTE = "com.flashlab.app.NOTIFICATION_MUTE";
    static final String EXTRA_CHAT_KEY = "chatKey";
    static final String EXTRA_USER_ID = "userId";
    static final String EXTRA_ACTION_TOKEN = "actionToken";
    static final String REPLY_KEY = "reply_text";

    private static final String KEY_MUTED = "muted_chats";
    private static final String KEY_SUPABASE_URL = "supabase_url";
    private static final String KEY_SUPABASE_KEY = "supabase_key";
    private static final int AVATAR_SIZE = 192;

    // chat abierto en pantalla (lo avisa ChatView vía FlashLabNativePlugin):
    // con la app en primer plano no se notifica el chat que ya estás leyendo
    private static volatile String viewingChatKey = null;

    private ChatNotifications() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(FlashLabMessagingService.PREFS_NAME, Context.MODE_PRIVATE);
    }

    static void setBackend(Context context, String supabaseUrl, String supabaseKey) {
        if (supabaseUrl == null || supabaseKey == null) return;
        prefs(context).edit().putString(KEY_SUPABASE_URL, supabaseUrl).putString(KEY_SUPABASE_KEY, supabaseKey).apply();
    }

    static void setViewingChat(Context context, String chatKey) {
        viewingChatKey = chatKey;
        if (chatKey != null) cancel(context, chatKey);
    }

    static String getViewingChat() {
        return viewingChatKey;
    }

    // --- silencio (solo en este teléfono, hasta que se reactive desde el chat)
    static Set<String> getMuted(Context context) {
        return new HashSet<>(prefs(context).getStringSet(KEY_MUTED, Collections.emptySet()));
    }

    static boolean isMuted(Context context, String chatKey) {
        return chatKey != null && getMuted(context).contains(chatKey);
    }

    static void setMuted(Context context, String chatKey, boolean muted) {
        Set<String> muted_ = getMuted(context);
        if (muted) muted_.add(chatKey);
        else muted_.remove(chatKey);
        prefs(context).edit().putStringSet(KEY_MUTED, muted_).apply();
    }

    static int notificationId(String chatKey) {
        return chatKey.hashCode();
    }

    static void cancel(Context context, String chatKey) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(NOTIFICATION_TAG, notificationId(chatKey));
    }

    private static String nonEmpty(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }

    static void show(Context context, Map<String, String> data) {
        if (Build.VERSION.SDK_INT >= 33
            && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "sin permiso POST_NOTIFICATIONS, no se muestra nada");
            return;
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        String chatKey = nonEmpty(data.get("chatKey"), "");
        String key = chatKey.isEmpty() ? "flashlab" : chatKey;
        int id = notificationId(key);
        String title = nonEmpty(data.get("title"), "FlashLab");
        String body = nonEmpty(data.get("body"), "");
        String senderName = nonEmpty(data.get("senderName"), title);
        boolean isGroup = "1".equals(data.get("isGroup"));
        String actionToken = nonEmpty(data.get("actionToken"), "");
        String userId = nonEmpty(data.get("recipientId"), "");

        Bitmap avatar = loadAvatar(context, data.get("avatarUrl"), data.get("avatarEmoji"));
        IconCompat avatarIcon = IconCompat.createWithBitmap(avatar);

        Person me = new Person.Builder().setName(context.getString(R.string.notification_you)).build();
        Person.Builder senderBuilder = new Person.Builder().setName(senderName);
        String senderId = data.get("senderId");
        if (senderId != null && !senderId.isEmpty()) senderBuilder.setKey(senderId);
        if (!isGroup) senderBuilder.setIcon(avatarIcon);
        Person sender = senderBuilder.build();

        // si ya hay una notificación de este chat, se le suma el mensaje (como
        // WhatsApp: una notificación por chat, con los últimos mensajes)
        NotificationCompat.MessagingStyle style = null;
        for (StatusBarNotification sbn : manager.getActiveNotifications()) {
            if (sbn.getId() == id && NOTIFICATION_TAG.equals(sbn.getTag())) {
                style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(sbn.getNotification());
                break;
            }
        }
        if (style == null) style = new NotificationCompat.MessagingStyle(me);
        style.setGroupConversation(isGroup);
        style.setConversationTitle(isGroup ? title : null);
        style.addMessage(body, System.currentTimeMillis(), sender);

        Intent openIntent = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (!chatKey.isEmpty()) openIntent.putExtra(EXTRA_CHAT_KEY, chatKey);
        PendingIntent contentIntent = PendingIntent.getActivity(
            context, id, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, FlashLabApplication.CHAT_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notification)
            .setColor(ContextCompat.getColor(context, R.color.notification_color))
            .setLargeIcon(avatar)
            .setContentTitle(title)
            .setContentText(isGroup ? senderName + ": " + body : body)
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setContentIntent(contentIntent);

        if (!chatKey.isEmpty()) {
            // "conversación" de Android 11+: es lo que pone la foto grande a
            // la izquierda con el ícono de la app de insignia (como WhatsApp)
            try {
                ShortcutInfoCompat.Builder shortcut = new ShortcutInfoCompat.Builder(context, chatKey)
                    .setShortLabel(title)
                    .setLongLived(true)
                    .setIcon(avatarIcon)
                    .setIntent(openIntent)
                    .setLocusId(new LocusIdCompat(chatKey));
                if (!isGroup) shortcut.setPerson(sender);
                ShortcutManagerCompat.pushDynamicShortcut(context, shortcut.build());
                builder.setShortcutId(chatKey).setLocusId(new LocusIdCompat(chatKey));
            } catch (Exception e) {
                Log.w(TAG, "no se pudo publicar el shortcut de conversación", e);
            }

            if (!actionToken.isEmpty() && !userId.isEmpty()) {
                RemoteInput remoteInput = new RemoteInput.Builder(REPLY_KEY)
                    .setLabel(context.getString(R.string.notification_reply_hint))
                    .build();
                int replyFlags = PendingIntent.FLAG_UPDATE_CURRENT
                    | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
                builder.addAction(new NotificationCompat.Action.Builder(
                        R.drawable.ic_stat_notification,
                        context.getString(R.string.notification_reply),
                        PendingIntent.getBroadcast(context, id * 10 + 1, actionIntent(context, ACTION_REPLY, chatKey, userId, actionToken), replyFlags))
                    .addRemoteInput(remoteInput)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                    .setShowsUserInterface(false)
                    .setAllowGeneratedReplies(true)
                    .build());
                builder.addAction(new NotificationCompat.Action.Builder(
                        R.drawable.ic_stat_notification,
                        context.getString(R.string.notification_mark_read),
                        broadcast(context, id * 10 + 2, actionIntent(context, ACTION_MARK_READ, chatKey, userId, actionToken)))
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
                    .setShowsUserInterface(false)
                    .build());
            }
            builder.addAction(new NotificationCompat.Action.Builder(
                    R.drawable.ic_stat_notification,
                    context.getString(R.string.notification_mute),
                    broadcast(context, id * 10 + 3, actionIntent(context, ACTION_MUTE, chatKey, userId, actionToken)))
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MUTE)
                .setShowsUserInterface(false)
                .build());
        }

        manager.notify(NOTIFICATION_TAG, id, builder.build());
    }

    private static Intent actionIntent(Context context, String action, String chatKey, String userId, String token) {
        return new Intent(context, NotificationActionReceiver.class)
            .setAction(action)
            .putExtra(EXTRA_CHAT_KEY, chatKey)
            .putExtra(EXTRA_USER_ID, userId)
            .putExtra(EXTRA_ACTION_TOKEN, token);
    }

    private static PendingIntent broadcast(Context context, int requestCode, Intent intent) {
        return PendingIntent.getBroadcast(
            context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // la respuesta falló: hay que volver a publicar la notificación sí o sí
    // (si no, Android la deja con el "enviando…" girando para siempre)
    static void markReplyFailed(Context context, String chatKey) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        int id = notificationId(chatKey);
        for (StatusBarNotification sbn : manager.getActiveNotifications()) {
            if (sbn.getId() == id && NOTIFICATION_TAG.equals(sbn.getTag())) {
                Notification.Builder builder = Notification.Builder.recoverBuilder(context, sbn.getNotification());
                builder.setSubText(context.getString(R.string.notification_reply_failed));
                manager.notify(NOTIFICATION_TAG, id, builder.build());
                return;
            }
        }
    }

    // --- red: misma edge function que manda los push, autorizada con el
    // token de acción que vino en el push (no hay sesión con la app cerrada)
    static boolean postAction(Context context, JSONObject payload) {
        String baseUrl = prefs(context).getString(KEY_SUPABASE_URL, null);
        String apiKey = prefs(context).getString(KEY_SUPABASE_KEY, null);
        if (baseUrl == null || apiKey == null) return false;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(baseUrl + "/functions/v1/send-chat-push").openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(15000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("apikey", apiKey);
            connection.setRequestProperty("Authorization", "Bearer " + apiKey);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(payload.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = connection.getResponseCode();
            if (code != 200) Log.w(TAG, "acción de notificación respondió " + code);
            return code == 200;
        } catch (Exception e) {
            Log.w(TAG, "falló la acción de notificación", e);
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    // --- avatar: siempre en círculo; foto -> emoji del grupo -> logo
    static Bitmap loadAvatar(Context context, String url, String emoji) {
        Bitmap source = null;
        if (url != null && url.startsWith("https://")) source = downloadCached(context, url);
        if (source == null && emoji != null && !emoji.isEmpty()) source = drawEmoji(emoji);
        if (source == null) source = appLogo(context);
        return circle(source);
    }

    private static Bitmap downloadCached(Context context, String url) {
        // las fotos de Google vienen con "=s96-c" (96px): se pide más grande
        String sized = url.replaceAll("=s\\d+-c$", "=s" + AVATAR_SIZE + "-c");
        File dir = new File(context.getCacheDir(), "notification-avatars");
        File file = new File(dir, sha1(sized) + ".png");
        if (file.exists() && System.currentTimeMillis() - file.lastModified() < 24L * 3600 * 1000) {
            Bitmap cached = BitmapFactory.decodeFile(file.getAbsolutePath());
            if (cached != null) return cached;
        }
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(sized).openConnection();
            connection.setConnectTimeout(4000);
            connection.setReadTimeout(4000);
            if (connection.getResponseCode() != 200) return null;
            Bitmap bitmap;
            try (InputStream in = connection.getInputStream()) {
                bitmap = BitmapFactory.decodeStream(in);
            }
            if (bitmap != null) {
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                try (FileOutputStream out = new FileOutputStream(file)) {
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
                }
            }
            return bitmap;
        } catch (Exception e) {
            Log.w(TAG, "no se pudo bajar la foto de la notificación", e);
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static Bitmap drawEmoji(String emoji) {
        Bitmap bitmap = Bitmap.createBitmap(AVATAR_SIZE, AVATAR_SIZE, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(Color.parseColor("#E5E7EB"));
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setTextSize(AVATAR_SIZE * 0.55f);
        paint.setTextAlign(Paint.Align.CENTER);
        Paint.FontMetrics metrics = paint.getFontMetrics();
        canvas.drawText(emoji, AVATAR_SIZE / 2f, AVATAR_SIZE / 2f - (metrics.ascent + metrics.descent) / 2f, paint);
        return bitmap;
    }

    private static Bitmap appLogo(Context context) {
        Bitmap bitmap = Bitmap.createBitmap(AVATAR_SIZE, AVATAR_SIZE, Bitmap.Config.ARGB_8888);
        Drawable drawable = ContextCompat.getDrawable(context, R.mipmap.ic_launcher);
        if (drawable != null) {
            Canvas canvas = new Canvas(bitmap);
            drawable.setBounds(0, 0, AVATAR_SIZE, AVATAR_SIZE);
            drawable.draw(canvas);
        }
        return bitmap;
    }

    private static Bitmap circle(Bitmap source) {
        Bitmap output = Bitmap.createBitmap(AVATAR_SIZE, AVATAR_SIZE, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(output);
        BitmapShader shader = new BitmapShader(source, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
        // center-crop al cuadrado del avatar
        float scale = Math.max((float) AVATAR_SIZE / source.getWidth(), (float) AVATAR_SIZE / source.getHeight());
        Matrix matrix = new Matrix();
        matrix.setScale(scale, scale);
        matrix.postTranslate((AVATAR_SIZE - source.getWidth() * scale) / 2f, (AVATAR_SIZE - source.getHeight() * scale) / 2f);
        shader.setLocalMatrix(matrix);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setShader(shader);
        canvas.drawCircle(AVATAR_SIZE / 2f, AVATAR_SIZE / 2f, AVATAR_SIZE / 2f, paint);
        return output;
    }

    private static String sha1(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-1").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : digest) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (Exception e) {
            return Integer.toHexString(value.hashCode());
        }
    }
}
