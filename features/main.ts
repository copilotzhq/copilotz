/**
 * Health check endpoint
 * @returns {Object} - Health check response
 */
function healthCheck() {
    return {
        status: 'ok'
    }
}

export default healthCheck;