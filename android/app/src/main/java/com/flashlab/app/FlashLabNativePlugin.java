package com.flashlab.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "FlashLabNative")
public class FlashLabNativePlugin extends Plugin {
    @PluginMethod
    public void setActiveUser(PluginCall call) {
        String userId = call.getString("userId");
        FlashLabMessagingService.setActiveUserId(getContext(), userId);
        call.resolve();
    }

    // Si el usuario negó el permiso (Android 13+ deja de preguntar después de
    // dos "No") o silenció el canal de chat, los push llegan al teléfono pero
    // el sistema no muestra nada y nadie se entera — ni la app ni FCM ven un
    // error. Esto permite detectarlo y avisar en la UI.
    @PluginMethod
    public void getNotificationStatus(PluginCall call) {
        Context context = getContext();
        boolean appEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled();
        boolean channelEnabled = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            NotificationChannel channel = manager != null
                ? manager.getNotificationChannel(FlashLabApplication.CHAT_CHANNEL_ID)
                : null;
            channelEnabled = channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
        }
        JSObject result = new JSObject();
        result.put("appEnabled", appEnabled);
        result.put("channelEnabled", channelEnabled);
        call.resolve(result);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Context context = getContext();
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(android.net.Uri.fromParts("package", context.getPackageName(), null));
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
        call.resolve();
    }
}
