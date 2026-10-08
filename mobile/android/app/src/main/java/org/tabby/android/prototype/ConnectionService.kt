package org.tabby.android.prototype

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/** Opt-in, visible, non-sticky process ownership; never a promise against system termination. */
class ConnectionService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            enabled = false
            SSHRuntime.get(this).closeAll("user_stopped")
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
            return START_NOT_STICKY
        }
        try {
            detaching = false
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "SSH 后台连接", NotificationManager.IMPORTANCE_LOW))
            val notification = notification(SSHRuntime.get(this).sessions.size)
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            else startForeground(ID, notification)
            enabled = true
        } catch (_: Throwable) { enabled = false; SSHRuntime.get(this).closeAll("background_service_failed"); stopSelf() }
        return START_NOT_STICKY
    }
    private fun notification(count: Int) = makeNotification(this, count)
    override fun onDestroy() {
        enabled = false
        if (!detaching) SSHRuntime.get(this).closeAll("background_service_stopped")
        detaching = false
        super.onDestroy()
    }
    companion object {
        private var detaching = false
        private fun makeNotification(context: Context, count: Int) = NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("Tabby · 后台连接")
        .setContentText("$count 个连接 · 系统或网络仍可能中断")
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setOngoing(true).setOnlyAlertOnce(true)
        .setContentIntent(PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        .addAction(0, "停止全部", PendingIntent.getService(context, 1, Intent(context, ConnectionService::class.java).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        .build()
        const val STOP = "org.tabby.android.prototype.STOP_CONNECTIONS"
        private const val ID = 107; private const val CHANNEL = "ssh-background-v1"
        @Volatile var enabled = false
            private set
        fun notificationsAllowed(context: Context) =
            (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
        fun start(context: Context) {
            require(notificationsAllowed(context))
            ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java))
        }
        fun disable(context: Context) { enabled = false; detaching = true; context.stopService(Intent(context, ConnectionService::class.java)) }
        fun connectionsChanged(context: Context, count: Int) {
            if (enabled) {
                if (count == 0) { disable(context) }
                else context.getSystemService(NotificationManager::class.java).notify(ID, makeNotification(context, count))
            }
        }
    }
}
