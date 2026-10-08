package org.tabby.android.prototype

/** A late cancellation from one Tab must not cancel another Tab's SAF request. */
data class PickerScope(val ownerId: String?, val requestId: String?) {
    init {
        require((ownerId == null) == (requestId == null))
        for (value in listOfNotNull(ownerId, requestId)) {
            require(value.isNotEmpty() && value.length <= 128 && !value.any { it.code < 32 || it.code == 127 })
        }
    }
}
