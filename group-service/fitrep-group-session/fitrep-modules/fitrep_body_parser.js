const Ajv = require('ajv');
const empty = require('is-empty');
module.exports = FitRepBodyParser;

function FitRepBodyParser(event) {
    this.version = 1
    this.event = event
    this.isBase64Encoded = event.isBase64Encoded
    this.body = event.body
    this.request_query_string = event.queryStringParameters
    this.schema = {}
    this.request_schema = {}
}

FitRepBodyParser.prototype.setSchema = function (schema) {
    this.schema = JSON.parse(schema)
    return this
}

FitRepBodyParser.prototype.setRequestSchema = function (request_schema) {
    this.request_schema = JSON.parse(request_schema)
    return this
}

FitRepBodyParser.prototype.getJsonBody = function () {
    return new Promise((resolve, reject) => {
        try {
            if (this.isBase64Encoded) {
                this.body = JSON.parse(new Buffer(this.body, 'base64').toString('utf8'));
            } else {
                this.body = JSON.parse(this.body)
            }
        } catch (ex) {
            reject(ex)
        }
        resolve(this.body)
    });
};

FitRepBodyParser.prototype.getBody = function () {
    return new Promise((resolve, reject) => {
        if (this.isBase64Encoded) {
            this.body = (new Buffer(this.body, 'base64').toString('utf8'));
        } else {
            this.body = (this.body)
        }
        resolve(this.body)
    });
};

FitRepBodyParser.prototype.validateBody = function () {
    return new Promise((resolve, reject) => {
        if (empty(this.schema)) {
            resolve(this.body)
        }
        let ajv = new Ajv({ allErrors: true })
        let validate = ajv.compile(this.schema);
        let valid = validate(this.body);
        if (!valid) {
            reject(validate.errors)
        } else {
            resolve(this.body)
        }
    });
};

FitRepBodyParser.prototype.validateRequest = function () {
    return new Promise((resolve, reject) => {
        if (empty(this.request_schema)) {
            resolve(this.body)
        }
        let ajv = new Ajv({ allErrors: true })
        let validate = ajv.compile(this.request_schema);
        let valid = validate(this.request_query_string);
        if (!valid) {
            reject(validate.errors)
        } else {
            resolve(this.body)
        }
    });
};

FitRepBodyParser.prototype.getUser = function () {
    return this.event.requestContext.authorizer.claims
}