'use strict'

class db_helper_ops {
    constructor(documentClient) {
        this.documentClient = documentClient;
    }
    
    flattenLastEvaluatedKey(lastEvaluatedKey_object){
        console.log('Incoming LEK result:', lastEvaluatedKey_object);
        if (lastEvaluatedKey_object){
            let stringLEK = "";
            // create flattened string from LastEvaluatedKey object
            for (let key in lastEvaluatedKey_object)
                stringLEK = stringLEK + key + ":" + lastEvaluatedKey_object[key] + ",";
            // erase last "," in string
            stringLEK = stringLEK.slice(0, -1);

            console.log('flattened LEK result:', stringLEK);
            return Promise.resolve(stringLEK);
        }
        // return undefined by default
        return Promise.resolve(undefined);
    }

    expandLastEvaluatedKey(lastEvaluatedKey_string){
        console.log('Incoming LEK string:', lastEvaluatedKey_string);
        let paginationInfo = {};
        // split query string into separate items
        let arr = lastEvaluatedKey_string.split(",");
        for (let item in arr) {
            let innerArr = arr[item].split(":");
            paginationInfo[innerArr[0]] = innerArr[1];
        }
        // startTime needs to be a number
        paginationInfo.startTime = parseInt(paginationInfo.startTime);

        console.log('expanded LEK result:', paginationInfo);
        return Promise.resolve(paginationInfo);
    }

    getTotalSessions(moment) {
        // get the current timestamp
        var now = moment().unix(); // in seconds
    
        let countParams = {
            TableName: process.env.GROUP_SESSION_TABLE,
            IndexName: process.env.AWS_DynamoDB_GSI_INDEX_AllSessionsStartTime,
            KeyConditionExpression: 'tempSelectAll = :hkey AND startTime > :currentTime',
            ExpressionAttributeValues: {
              ':hkey': '*',
              ':currentTime': now
            },
            Select: 'COUNT'
        }

        return this.documentClient.query(countParams).promise().then(result => {
            console.log('getTotalSessions RESULT:', result);
            return Promise.resolve(result.Count);
        })
        .catch(err => {
            console.log('getTotalSessions ERROR:', err);
            return Promise.reject(err);
        });
    }
}
module.exports = db_helper_ops;