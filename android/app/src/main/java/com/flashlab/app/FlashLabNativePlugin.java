package com.flashlab.app;

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
}

