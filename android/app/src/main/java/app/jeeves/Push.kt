package app.jeeves

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.unifiedpush.android.connector.UnifiedPush
import kotlin.coroutines.resume

/** Registers this phone for push through a UnifiedPush distributor (ntfy). */
object Push {
    enum class Status { ON, NO_DISTRIBUTOR, SERVER_OFF, REGISTERING, ERROR }

    private const val NTFY_PACKAGE = "io.heckel.ntfy"

    /** Fire and forget, for app start and pairing. */
    fun ensureRegistered(context: Context) {
        val app = context.applicationContext
        CoroutineScope(Dispatchers.IO).launch { register(app) }
    }

    /**
     * Asks the server for its VAPID key, picks a distributor and registers. The endpoint arrives later in
     * [PushReceiver.onNewEndpoint], so [Status.ON] means "already registered", else [Status.REGISTERING].
     */
    suspend fun register(context: Context): Status {
        val prefs = Prefs(context)
        if (!prefs.isPaired) return Status.ERROR
        return try {
            val key = Api(prefs).vapidKey() ?: return Status.SERVER_OFF
            if (UnifiedPush.getDistributors(context).isEmpty()) return Status.NO_DISTRIBUTOR
            val ready = suspendCancellableCoroutine { cont ->
                UnifiedPush.tryUseCurrentOrDefaultDistributor(context) { ok -> if (cont.isActive) cont.resume(ok) }
            }
            if (!ready) return Status.NO_DISTRIBUTOR
            UnifiedPush.register(context, vapid = key)
            if (prefs.pushEndpoint != null) Status.ON else Status.REGISTERING
        } catch (e: Exception) {
            Log.w("Jeeves", "Push registration failed", e)
            Status.ERROR
        }
    }

    /** Opens the ntfy page on F-Droid. */
    fun openNtfyListing(context: Context) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://f-droid.org/packages/$NTFY_PACKAGE/"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}
