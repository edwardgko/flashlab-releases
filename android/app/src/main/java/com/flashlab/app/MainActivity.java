package com.flashlab.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getApplication() instanceof FlashLabApplication) {
            ((FlashLabApplication) getApplication()).createNotificationChannels();
        }
    }
}
