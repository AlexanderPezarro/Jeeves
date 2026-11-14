package app.jeeves

import android.app.Application

class JeevesApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifications.createChannel(this)
        if (Prefs(this).isPaired) startBackground()
    }

    /** Wi-Fi trigger plus the 15-minute poll. Safe to call more than once. */
    fun startBackground() {
        WifiTrigger.register(this)
        Work.schedulePeriodic(this)
    }
}
