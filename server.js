var express = require('express')
var fs = require('fs')
var https = require('https')
var app = express();

var credentials = {
  key: fs.readFileSync("key.pem"),
  cert: fs.readFileSync("cert.pem")
};


var api = require('instagram-node').instagram();
api.use({
  client_id: process.env.FACEBOOK_CLIENT_ID,
  client_secret: process.env.FACEBOOK_CLIENT_SECRET
});

var redirect_uri = process.env.INSTANGRAM_BASE_URL + '/auth';

// A middleware for log
app.use(function(req, res, next){
    var fullUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
    console.log('Url: ' + fullUrl, 'debug');
    console.log('Params: ' + JSON.stringify(req.params), 'debug');
    console.log('Query: ' + JSON.stringify(req.query), 'debug');
    next();
})

app.get('/', function(req, res){
    res.send('Server is working well ...');
})

// This is where you would initially send users to authorize
app.get('/authorize_user', function(req, res) {
  res.redirect(
      api.get_authorization_url(redirect_uri, {
                                                    scope: ['user_profile','user_media'],
                                                    state: 'a state' 
                                                })
    );
});

// This is your redirect URI
app.get('/auth', function(req, res) {
  api.authorize_user(req.query.code, redirect_uri, function(err, result) {
    if (err) {
      console.log(err.body);
      res.send("Didn't work");
    } else {
      console.log('Yay! Access token is ' + result.access_token);
      res.send('You made it!!');
    }
  });
});

https
  .createServer(
		credentials,
    app
  )
  .listen(3000, () => {
    console.log("server is runing at port 3000");
  });