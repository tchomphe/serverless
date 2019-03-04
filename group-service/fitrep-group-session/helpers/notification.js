var AWS = require('aws-sdk');

NotificationModule = function () {
    var sns = new AWS.SNS();

    this.send = function (data) {
        var message = {
            'data': data
        };

        var sns_payload = {
            'default': '',
            'lambda': message
        };

        return new Promise((resolve, reject) => {

            sns.publish({
                TopicArn: process.env.AWS_SNS_ARN,
                Message: JSON.stringify(sns_payload)
            }, function (err, data) {
                if (err) {
                    reject(err)
                } else {
                    resolve(data);
                }
            });

        });
    }
};

module.exports = NotificationModule;