'use strict';
const AWS = require('aws-sdk');
const uuidv4 = require('uuid/v4');
const moment = require('moment-timezone');
const empty = require('is-empty');
const FRBodyParser = require('./fitrep-modules/fitrep_body_parser');
const FRBodyResponse = require('./fitrep-modules/fitrep_body_response');
const DocumentClient = new AWS.DynamoDB.DocumentClient();
const DBObject = require("./helpers/db_helper_ops.js"); // maybe rename
const dbInstance = new DBObject(DocumentClient);

module.exports.create = async (event, context, callback) => {
  const ssm = new AWS.SSM();
  let payload = JSON.parse(event.body);
  let br = new FRBodyResponse();
  let validated = false;
  console.log('EVENT: ', event);

  let ssm_params = {
    Name: process.env.BACKOFFICE_SSM_PARAMETER,
    WithDecryption: true
  };

  // Custom authentication for back-office operations
  let ssm_users = await ssm.getParameter(ssm_params).promise();

  let users = JSON.parse(ssm_users.Parameter.Value);
  users.users.forEach(user => {
    if (user.user == payload.email && user.password == payload.password) {
      validated = true
    }
  });

  if (!validated) {
    console.log('403, FAILED TO VALIDATE USER CREDENTIAL!');
    return callback(null, br.setStatusCode(403).getResponse());
  }

  let sessionTime = moment.tz(payload.date, "America/Toronto"); // Time conversion

  let get_params = {
    Key: { id: payload.trainerId },
    TableName: process.env.USER_TABLE
  };

  let trainer;
  let session;

  try {
    let result = await DocumentClient.get(get_params).promise();
    trainer = result.Item;
    session = {
      id: 'G' + uuidv4(),
      tempSelectAll: '*',
      trainerId: payload.trainerId,
      name: {
        first: trainer.user_settings.firstName,
        last: trainer.user_settings.lastName
      },
      workout: {
        title: payload.title,
        activity: payload.activity,
        level: payload.level,
        spaceDetail: payload.spaceDetail,
        notes: payload.notes,
        description: payload.description,
      },
      version: 0,
      trainerRating: trainer.user_settings.rating.score,
      users: {},
      availableSpots: parseInt(payload.size),
      type: payload.type,
      size: parseInt(payload.size),
      fee: parseFloat(payload.rate),
      images: [
        {
          imageType: 'portrait',
          imageURL: empty(payload.coverImageURL) ? null : payload.coverImageURL
        },
        {
          imageType: 'avatar',
          imageURL: empty(trainer.user_settings.avatar.file) ? null : trainer.user_settings.avatar.file
        }
      ],
      address: {
        title: payload.googleResult.name,
        formatted: payload.googleResult.formatted_address,
        url: payload.googleResult.url,
        placeId: payload.googleResult.place_id,
        lat: payload.googleResult.location.lat,
        lng: payload.googleResult.location.lng
      },
      startTime: sessionTime.unix(),
      date: sessionTime.format('MMM Do YYYY h:mmA'),
      duration: payload.duration
    }
  } catch (err) {
    console.log('FAILED TO FETCH TRAINER INFORMATION. ERROR: ', err);
    callback(null, br.setStatusCode(500).setError([{ code: 'SGS', message: 'Failed to create your group session' }]).getResponse());
  }

  try {
    let put_params = {
      TableName: process.env.GROUP_SESSION_TABLE,
      Item: session
    };

    await DocumentClient.put(put_params).promise();

    callback(null, br.setHeaders({
      "Access-Control-Allow-Origin": "*", // Required for CORS support to work
      "Access-Control-Allow-Credentials": true // Required for cookies, authorization headers with HTTPS 
    }).getDefaultResponse());
  } catch (err) {
    console.log('FAILED TO WRITE SESSION TO DATABASE. ERROR: ', err);
    callback(null, br.setStatusCode(500).setError([{ code: 'SGS', message: 'Failed to create your group session' }]).getResponse());
  }
};

module.exports.reserve = async (event, context, callback) => {
  const randomstring = require('randomstring');
  const axios = require('axios');
  const notificationObject = require('./helpers/notification.js');
  const notification = new notificationObject();

  console.log('EVENT: ', event);
  const auth_token = event.headers.Authorization;
  let payload = JSON.parse(event.body);
  let bp = new FRBodyParser(event);
  let br = new FRBodyResponse();
  let user = bp.getUser();
  let currentTime = moment().unix();

  let groupSessionId = payload.groupSessionId;
  let sessionId = 'G' + uuidv4();
  let response, stripe_response;
  let params = {
    TableName: process.env.GROUP_SESSION_TABLE,
    Key: {
      'id': groupSessionId
    },
    ConditionExpression: 'attribute_not_exists(#users.#user) AND #availableSpots > :min AND #startTime > :currentTime',
    UpdateExpression: 'SET #users.#user = :val ADD #version :incrementValue, #availableSpots :decrementValue',
    ExpressionAttributeNames: {
      '#users': 'users',
      '#version': 'version',
      '#availableSpots': 'availableSpots',
      '#user': user.sub,
      '#startTime': 'startTime'
    },
    ExpressionAttributeValues: {
      ':val': true,
      ':incrementValue': 1,
      ':decrementValue': -1,
      ':min': 0,
      ':currentTime': currentTime
    },
    ReturnValues: 'ALL_NEW'
  };
  // Update group session by pushing user to the list
  try {
    let resp = await DocumentClient.update(params).promise();
    response = resp.Attributes;
    console.log('UPDATED GROUP SESSION TABLE, RESULT: ', response);
  } catch (err) {
    console.log('FAILED TO RESERVE SPOT IN GROUP SESSION, ERROR: ', err);
    callback(null, br.setStatusCode(400).setError([{ code: 'SGS', message: 'This group session has either been fully booked or you have already reserved a spot for it.' }]).getResponse());
  }

  let header = { headers: { 'Authorization': auth_token } };
  let stripe_url = process.env.STRIPE_CHARGE_URL;
  let stripe_payload = {
    stripe_source_id: payload.stripe_source_id,
    expiration: parseInt(payload.expiration),
    quoteToken: payload.quoteToken, // ???? is input going to be generated from front end or backend
    sessionId: sessionId,
    capture: true
  };
  // Process stripe payment
  try {
    stripe_response = await axios.post(stripe_url, stripe_payload, header);
    console.log('STRIPE PAYMENT MADE, RESPONSE: ', stripe_response);
  } catch (err) {
    console.log('AXIOS STRIPE ERR: ', err);
    console.log('ROLLINGBACK, REMOVE USER FROM GROUP SESSION');
    let remove_params = {
      TableName: process.env.GROUP_SESSION_TABLE,
      Key: {
        'id': groupSessionId
      },
      ConditionExpression: 'attribute_exists(#users.#user)',
      UpdateExpression: 'REMOVE #users.#user ADD #version :decrementValue, #availableSpots :incrementValue',
      ExpressionAttributeNames: {
        '#users': 'users',
        '#user': user.sub,
        '#version': 'version',
        '#availableSpots': 'availableSpots'
      },
      ExpressionAttributeValues: {
        ':incrementValue': 1,
        ':decrementValue': -1,
      },
      ReturnValues: 'ALL_NEW'
    };
    // Rollback by removing user from the group session list
    try {
      await DocumentClient.update(remove_params).promise();
      console.log('ROLLBACK SUCCESSFUL, RESULT: ', res);
      return callback(null, br.setStatusCode(400).setError([{ code: 'SGS_STRIPE_ERROR', message: 'Error in payment operation' }]).getResponse());
    } catch (error) {
      console.log('ERROR IN ROLLING BACK, ERROR: ', err);
    }
  }
  let etag = randomstring.generate({ length: parseInt(6), charset: 'alphabetic' }).toString();

  let status = {
    basic: "Confirmed",
    extra: "Deprecated. Use status_alt_trainee/status_alt_trainer",
    extra_trainee: "Your booking has been confirmed. See you at your workout!",
    extra_trainer: "Your booking has been confirmed. See you at your workout!"
  };

  let session = {
    location: {
      formatted_address: response.address.formatted,
      lat: response.address.lat,
      lng: response.address.lng,
      name: response.address.title,
      radius: null,
      travel: null,
      url: response.address.url
    },
    message: null,
    participants: '1',
    startTime: moment.unix(response.startTime).format(), // '2019-01-11T10:00:00+00:00',
    workout: response.type,
    // Additional duration field for group sessions to create custom time length during cronjob creation for systemSessionDone
    duration: parseInt(response.duration)
  };

  let custom_event = {
    etag: etag,
    event: 'TrainerAcceptSessionRequestEvent', // Using same event to follow the same flow for cancellation, completion and reviewing event. TraineePurchaseGroupSessionEvent
    expiration: 0,
    input: {
      quoteToken: payload.quoteToken,
      stripeCharge: {
        token: stripe_response.data.data.stripeCharge.token
      }
    },
    status: status,
    task: 'ManageSession',
    timestamp: moment().tz("Etc/UTC").unix()
  };

  let overview = {
    sessionId: sessionId,
    groupSessionId: groupSessionId,
    traineeId: user.sub,
    trainerId: response.trainerId,
    events: [custom_event],
    sessions: [session],
    status: status.basic,
    etag: etag,
    startTime: response.startTime,
    past_session: null,
    current_session: session,
    new_session: null,
    task: 'ManageSession',
    paymentType: 'group'
  };

  let put_params = {
    TableName: process.env.AWS_DynamoDB_Session_Table,
    Item: overview
  };
  // Write session to session table 
  try {
    let result = await DocumentClient.put(put_params).promise();
    console.log('SESSION WRITTEN TO SESSION TABLE, RESPONSE: ', result);
  } catch (err) {
    console.log('ERROR WRITING SESSION TO SESSION TABLE: ', err);
    return callback(null, br.setStatusCode(400).setError([{ code: 'SGS_SESSION_ERROR', message: 'Error in booking operation' }]).getResponse());
  }

  overview.duration = response.duration;
  // Send notification to scheduling service for email and push notification
  try {
    await notification.send(overview);
    console.log('SNS SENT TO SCHEDULING SERVICE');
    return callback(null, br.setRawBody({ 'data': { 'session': overview } }).getResponse());
  } catch (err) {
    console.log('ERROR SENDING SNS TO SCHEDULING SERVICE: ', err);
  }
};

module.exports.list = (event, context, callback) => {
  console.log('EVENT: ', JSON.stringify(event));

  let bp = new FRBodyParser(event);
  let br = new FRBodyResponse();
  let now = moment().unix();                  // get the current unix epoch time in seconds
  let getAllSessions = Promise.resolve(-1);   // variable to hold the total number of upcoming sessions, resolves to -1 by default
  let expandLEK = Promise.resolve(undefined); // variable to hold result of expanded LEK, resolves to undefined by default
  let userId = bp.getUser().sub;

  //check that there are query parameters as part of the request
  if (!event.queryStringParameters) {
    br.setError([{ code: "SGS_INVALID_REQUEST", message: `Query Params are missing.` }]);
    return callback(null, br.setStatusCode(400).getResponse());
  }
  else if (!event.queryStringParameters.PageSize) {
    br.setError([{ code: "SGS_INVALID_REQUEST", message: `PageSize is missing in Query Params.` }]);
    return callback(null, br.setStatusCode(400).getResponse());
  }

  //create parameters for DyanamoDB call
  // NOTE: also filter out sessions which the current user has already booked
  let params = {
    TableName: process.env.GROUP_SESSION_TABLE,
    IndexName: process.env.AWS_DynamoDB_GSI_INDEX_AllSessionsStartTime,
    KeyConditionExpression: 'tempSelectAll = :hkey and startTime > :currentTime',
    ExpressionAttributeValues: {
      ':hkey': '*',
      ':currentTime': now
    },
    Limit: event.queryStringParameters.PageSize
  };

  //check if the request's query string contains the LastEvaluatedKey
  if (event.queryStringParameters.LastEvaluatedKey) {
    //expand LEK into an object if necessary
    if (event.queryStringParameters.LastEvaluatedKey !== "") {
      console.log('LastEvaluatedKey found, expanding..');
      expandLEK = dbInstance.expandLastEvaluatedKey(event.queryStringParameters.LastEvaluatedKey);
    } else {
      console.log("NO LastEvaluatedKey! (or it's empty)");
    }
  } else {
    console.log('NO LastEvaluatedKey!');
    getAllSessions = dbInstance.getTotalSessions(moment);
  }

  //check that LEK is expanded, and continue to DB query
  expandLEK.then(expandLEKresult => {
    // append LEK as ExclusiveStartKey (or undefined) to db params
    params.ExclusiveStartKey = expandLEKresult;

    DocumentClient.query(params).promise().then(dynamoResult => {
      console.log('QUERY RESULT: ', dynamoResult);
      // flatten LastEvaluatedKey into a string, format as follows; [startTime]:[userId]:[sessionId]
      let flattenLEK = dbInstance.flattenLastEvaluatedKey(dynamoResult.LastEvaluatedKey);
      // let flattenLEK = dbInstance.flattenLastEvaluatedKey(formattedObj.LastEvaluatedKey);

      // check if getAllSessions was called and append the result to response
      Promise.all([getAllSessions, flattenLEK]).then(([getAllSessionsResult, stringLEKresult]) => {
        console.log('1) getAllSessionsResult ->', getAllSessionsResult);
        console.log('2) stringLEKresult ->', stringLEKresult);
        
        // Parsing the result data to check if requester's id exists within any item in the result
        dynamoResult.Items.forEach((session) => {
          if (session.users[userId]) {
            session.booked = true;
          }
        });
        
        console.log('FINAL RESULT: ', JSON.stringify(dynamoResult.Items));
        // send request back to frontend
        return callback(null, br.setBody({
          sessions: dynamoResult.Items,
          // sessions: formattedObj.Items,
          LastEvaluatedKey: stringLEKresult, // is undefined when there are no more pages
          count: getAllSessionsResult
        }).getResponse());

      }).catch(err => {
        console.log('DB ERROR (getUpcomingSessions.getAllSessions): ', err);
        return callback(null, br.setStatusCode(500).setError([{ code: 'SGS_DATABASE_ERROR', message: 'Error in database operation' }]).getResponse());
      });
    }).catch((error) => {
      console.log('ERROR: ', error);
      callback(null, br.setStatusCode(500).setError([{ code: 'SGS_SERVER_ERROR', message: 'Server Error' }]).getResponse());
    });
  });
}

module.exports.get = async (event, context, callback) => {
  let br = new FRBodyResponse();

  let params = {
    TableName: process.env.GROUP_SESSION_TABLE,
    Key: {
      id: event.queryStringParameters.id
    }
  };

  try {
    let session = await DocumentClient.get(params).promise();
    console.log('RESPONSE: ', session);
    callback(null, br.setBody(session.Item).getResponse());
  } catch (err) {
    console.log('ERROR: ', error);
    callback(null, br.setStatusCode(500).setError([{ code: 'SGS_SERVER_ERROR', message: 'Server Error' }]).getResponse());
  }

  // DocumentClient.get(params).promise().then(response => {
  //   console.log('RESPONSE: ', response);
  //   callback(null, br.setBody(response.Item).getResponse());
  // }).catch(error => {
  //   console.log('ERROR: ', error);
  //   callback(null, br.setStatusCode(500).setError([{ code: 'SGS_SERVER_ERROR', message: 'Server Error' }]).getResponse());
  // })
};