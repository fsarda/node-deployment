#!/usr/bin/env node
// # The *Deployment* Server

// Load vendor modules
var express = require('express');
var path = require('path');
var fs = require('fs');

// Load the configuration file
var config = JSON.parse(fs.readFileSync(path.join(__dirname + "/config.json"), "utf8"));
var modules = JSON.parse(fs.readFileSync(path.join(__dirname + "/deployment-modules.json"), "utf8"));
var servers = JSON.parse(fs.readFileSync(path.join(__dirname + "/deployment-servers.json"), "utf8"));
var configDeployData = JSON.parse(fs.readFileSync(path.join(__dirname + "/deployment-config.json"), "utf8"));

var server = express.createServer();

//Setting up server configuration
server.configure(function(){
    server.set('views', __dirname + '/views');
    server.set('view engine', 'html');
    server.use(express.favicon());
    server.use(express.logger('dev'));
    server.use(express.static(__dirname + '/public'));
    server.use(express.methodOverride());
    server.use(server.router);
    
});

//Verifies if the request comes from  github
var isRequestFromGitHubRepository = function(request, configData){
    return request.repository!=undefined && configData.repositoryName.toUpperCase() === request.repository.name.toUpperCase();
}


//Verifies conditions for running authomatized deployment
var isAuthorizedProductionChange = function(request, configData){
    
    //Check if is a production branch push
    var response = request.ref.indexOf(configData.productionBranch)!=-1;
    
    //Not everyone is authorized. Let's check if the pusher is
    if(configData.authorizedCommitUsers.length!=0){
	response = response && configData.authorizedCommitUsers.indexOf(request.pusher.name) != -1;
    }

    return response;

}

//Get list of servers where modifications where made
var getChangesLocation = function(request){
    
    var modules = [];

    //collect the path changed
    for(commit in request.commits){
	
    }
}

//Get dependency subGraph
var getDependencySubGraph = function(request,serversModified){

}


//Setting up action on '/deployment' url post
server.post('/deployment', express.bodyParser(), function(req, res) {

    if(isRequestFromGitHubRepository(req.body, configDeployData)){
	console.log("This push is from github's " + configDeployData.repositoryName + " repository");

	if(isAuthorizedProductionChange(req.body, configDeployData)){	    
	    console.log("This is an authorized production branch push");
	    
	    servers = getChangesLocation(req);
	    graph = getDependencySubGraph(servers);
	    
	    try{
		//execute scripts
	    }catch(err){
		
	    }
	    
	    res.send("Proccessing...");
	}else{
	    res.send("This request does not correspond to an authorized production change " + req);	    
	}
	
    }else{
	res.send("This request does not have git hub hook's format " + req);
    }
    
}, function(err, req, res, next) {
    res.send("An error has occurred processing the request..." + err);
});

//Starting listener on configured port and host
server.listen(config.rpc.port,config.rpc.host);
console.log('Deployment server running on port "' + config.rpc.port);
