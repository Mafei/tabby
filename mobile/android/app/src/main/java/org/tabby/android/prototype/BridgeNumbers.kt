package org.tabby.android.prototype

/** Android JSON uses Integer for small JS integers, Long for larger integers. */
object BridgeNumbers {
    const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    fun integer(value: Any?, minimum: Long, maximum: Long): Long {
        val number = when (value) {
            is Int -> value.toLong()
            is Long -> value
            is Double -> {
                require(value.isFinite() && value >= -MAX_SAFE_INTEGER.toDouble() && value <= MAX_SAFE_INTEGER.toDouble())
                require(value == value.toLong().toDouble())
                value.toLong()
            }
            else -> throw IllegalArgumentException("Expected an integer JSON number")
        }
        require(number in minimum..maximum)
        return number
    }

    fun generation(value: Any?) = integer(value, 0, MAX_SAFE_INTEGER)
}
