module.exports = FitRepBodyResponse;

function FitRepBodyResponse() {
    this.body = {}
    this.response = {
        statusCode: 200,
        headers: null,
        body: this.body
    };
}
FitRepBodyResponse.prototype.getDefaultResponse = function () {
    this.body = { "data": null }
    return this.getResponse()
};
FitRepBodyResponse.prototype.getResponse = function () {
    this.response.body = JSON.stringify(this.body)
    return this.response
};
FitRepBodyResponse.prototype.setStatusCode = function (statusCode) {
    this.response.statusCode = statusCode
    return this
};
FitRepBodyResponse.prototype.setHeaders = function (headers) {
    this.response.headers = headers
    return this
};
FitRepBodyResponse.prototype.setBody = function (body) {
    this.body = { "data": body }
    return this
};
FitRepBodyResponse.prototype.setRawBody = function (body) {
    this.body = body
    return this
};
FitRepBodyResponse.prototype.setError = function (error) {
    this.body = { "data": null, "errors": error }
    return this
};