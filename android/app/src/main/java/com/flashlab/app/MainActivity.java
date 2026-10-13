package com.flashlab.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FlashLabNativePlugin.class);
        super.onCreate(savedInstanceState);
        // tocar una notificación de chat con la app cerrada: abre esa conversación
        FlashLabNativePlugin.captureLaunchChat(getIntent());
        if (getApplication() instanceof FlashLabApplication) {
            ((FlashLabApplication) getApplication()).createNotificationChannels();
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 101);
            }
        }
    }

    // misma idea con la app ya abierta (launchMode singleTask: llega acá)
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        FlashLabNativePlugin.captureLaunchChat(intent);
    }
}
