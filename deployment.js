#!/usr/bin/node
// # The *Deployment* Server

// Load vendor modules
var express = require('express');
var path = require('path');
var fs = require('fs');

// Load the configuration file
var config = JSON.parse(fs.readFileSync(path.join(__dirname + "/config.json"), "utf8"));

var server = express();

//Setting up server configuration
server.configure(function(){
    server.set('views', __dirname + '/views');
    server.set('view engine', 'html');
    server.use(express.favicon());
    server.use(express.logger('dev'));
    server.use(express.static(__dirname + '/public'));
    server.use(express.bodyParser());
    server.use(express.methodOverride());
    server.use(server.router);

});

//Setting up error handling
server.error(function(err, req, res, next){
    if (err instanceof SyntaxError) {
        res.render('404.jade');
    } else {
        next(err);
    }
});

//Rendering index.html on '/' url get
server.get('/', function(req, res){
    res.render('index.html');

});

//Setting up action on '/sayhello' url post
server.post('/sayhello', function(req, res){
 
    //For some reason, catch does not work when 
    //stringify throws an exception
    try{
	var result = JSON.stringify(req.body);
	res.send("Hello World!!! :D");
	console.log("\nSaying hello world " + JSON.stringify(req.body));
    }catch(error){
	res.send("Good Bye World :(");
	console.log("\nSaying good bye world " + JSON.stringify(req.body)  + "   "+error);
    }
});
    
//Starting listener on configured port and host
server.listen(config.rpc.port,config.rpc.host)
console.log('Deployment server running on port "' + config.rpc.port);