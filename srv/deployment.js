#!/usr/bin/env node
// # The *Deployment* Server

// Load vendor modules
var express = require('express');
var path = require('path');
var fs = require('fs');
var async = require('async');
var child = require('child_process');
var aws = require('aws-lib');

// Load configuration files
var config = JSON.parse(fs.readFileSync(path.join(__dirname + "/config.json"), "utf8"));
var modules = JSON.parse(fs.readFileSync(path.join(__dirname + "/deployment-modules.json"), "utf8"));
var server = express.createServer();

//global variables
var pendingServerRestarts = []; 
var pendingRetryExecutions = [];
var retryCount = 0;
var sesClient = aws.createSESClient(config.SES.key, config.SES.secret);

//Setting up server configuration
server.configure(function(){
    server.use(express.favicon());
    server.use(express.logger('dev'));
    server.use(express.methodOverride());
    server.use(server.router);
    
});


//Send report email
var sendReportEmail = function(message, errors, entities, instructions, pushjson, callback){

    var textBody ="A production deployment has been executed with the following characteristics: \n"+
	"Pushed by: " + pushjson.pusher.name+"\n"+
	"Commit id: " + pushjson.head_commit.id+"\n"+
	"Modified entities: " + entities+"\n\n";

    if(instructions.length!=0){
	textBody += "Instructions to execute: \n\n";
	
	for(i in instructions){
	    textBody += i+" instructions:\n";
	    for(j in instructions[i]){
		textBody += "- "+instructions[i][j]+"\n";
	    }
	}
	
    }
    
    textBody += "\n\nReport Message: " +message+"\n";
    textBody += "\n\nError message: " +errors+"\n";
    textBody += "\n\nFailed Instructions: " +pendingRetryExecutions+"\n";
    textBody += "\n\nServers not restarted: " +pendingServerRestarts+"\n";
	

    var htmlBody ="A production deployment has been executed with the following characteristics: <br/> "+
	"<span style='font-weight: bold; text-decoration: underline;'>Pushed by:</span> <a href='https://github.com/"+pushjson.pusher.name+"'>" + pushjson.pusher.name+"</a><br/>"+
	"<span style='font-weight: bold; text-decoration: underline;'>Commit id:</span> <a href='https://github.com/jsalcedo/Agrosica/commit/"+pushjson.head_commit.id+"'>" + pushjson.head_commit.id+"</a><br/>"+
	"<span style='font-weight: bold; text-decoration: underline;'>Modified entities:</span>" + entities+"<br/><br/>";

    if(instructions.length!=0){
	htmlBody += "<span style='font-weight: bold; text-decoration: underline;'>Instructions to execute:</span><br/><br/>";
	
	for(i in instructions){
	    htmlBody += "<span style='text-decoration: underline;'>"+i+" instructions:</span><br/>";
	    for(j in instructions[i]){
		htmlBody += "- "+instructions[i][j]+"<br/>";
	    }
	}
    }
    
    htmlBody += "<br/><span style='font-weight: bold; text-decoration: underline;'>Report Message:</span>" +message+"<br/>";
    htmlBody += "<br/><span style='font-weight: bold; text-decoration: underline;'>Error message:</span>" +errors+"<br/>";
    htmlBody += "<br/><span style='font-weight: bold; text-decoration: underline;'>Failed Insructions:</span>" +pendingRetryExecutions+"<br/>";
    htmlBody += "<br/><span style='font-weight: bold; text-decoration: underline;'>Servers not restarted:</span> " +pendingServerRestarts+"<br/>";
    

    //console.log(textBody);
    //console.log(htmlBody);
	
    var sendArgs = {
	'Destination.ToAddresses.member.1': config.deployEmail[0],
	'ReplyToAddresses.member.1': config.deployEmail[1],
	'Message.Body.Text.Charset': 'UTF-8',
	'Message.Body.Text.Data': textBody,
	'Message.Body.Html.Charset': 'UTF-8',
	'Message.Body.Html.Data': htmlBody,
	'Message.Subject.Charset': 'UTF-8',
	'Message.Subject.Data': 'Agrosica automatic deployment executed',
	'Source': config.sourceEmail
    };
    
    /*return sesClient.call('SendEmail', sendArgs, function(result) {
	if(result.Error) {
	    console.log(result);
	    return callback(new Error("There was an error sending the report email"));
	}
	return callback({success: true});
    });*/

    return callback({success: true});
};


//Verifies if the request comes from  github
var isRequestFromGitHubRepository = function(request, configData){
    return request.repository!=undefined && configData.repositoryName.toUpperCase() === request.repository.name.toUpperCase();
}

//Verifies conditions for running automated deployment
var isAuthorizedProductionChange = function(request, configData){
    
    //Check if is a production branch push
    var response = request.ref.indexOf(configData.productionBranch)!=-1;
    
    //Not everyone is authorized. Let's check if the pusher is
    if(configData.authorizedCommitUsers.length!=0){
	response = response && configData.authorizedCommitUsers.indexOf(request.pusher.name) != -1;
    }

    return response;

}

//Search the corresponding module for each entity changed
var getMappedEntity = function(val){
    
    //We are not interested in file names, only path to them
    var array = val.split("/");
    var rest =array.splice(0,array.length -1);
    val = rest.join("/");
    
    for(mod in modules){
	var paths = modules[mod].paths;
	for(path in paths){
	    if(val.search(paths[path])!= -1){
		return mod;
	    }
	}
    }
    
    return null;
};

//Get list of servers where modifications where made
var getModifiedEntities = function(request){
    
    var commitModules = [];

    //collect the changed paths
    for(commit in request.commits){
	var current = request.commits[commit];
	var added = current.added == undefined ? [] : current.added;
	var modified = current.modified== undefined ? [] :current.modified;
	var deleted = current.deleted== undefined ? [] :current.deleted;
	commitModules = commitModules.concat(added,modified,deleted);
    }
       
    //Getting affected entities
    affectedEntities = commitModules.map(getMappedEntity);
    affectedEntities = affectedEntities.sort();
    affectedEntities = affectedEntities.filter(function(val,ind,arr){return (val != null && val!=arr[ind -1]) });

    return affectedEntities;
}

/*
Get dependency subGraph: Given a set of modified entities
we want to build a graph containing the information to execute
deployment.
*/
var getActionsToTake = function(dependency, entity){

    var type = (entity==='none')?"initial":modules[entity].dependencies.filter(function(val){return val.name==dependency})[0].type;
    var action = "";
    var dependingEntity = modules[dependency];
    

    switch(type){
    case "hard":
	if(dependingEntity.type==="server"){
	    action = ["restart"];
	    pendingServerRestarts.push(dependency);
	}else{
	    action = ["copy","install"];
	}	
	break;
    case "soft":
	break;
    case "initial":
	if(dependingEntity.type==="server"){
	    action = ["copy","install","restart"];
	    pendingServerRestarts.push(dependency);
	}else{
	    action = ["copy","install"];
	}
	break;
    default:
	if(dependingEntity.type==="server"){
	    action = ["restart"];
	    pendingServerRestarts.push(dependency);
	}else{
	    action = ["copy","install"];
	}

	break;
    }
    
    return action;
}

//Search for dependency subgraph for changed entities
var getDependencySubGraph = function(entities){
    
    var result = [];
    var resultNames = [];
    var subgraph = [];
    var pending = [];
    var pendingNames = [];
    var pendingIndex = 0;
    
    //Initialize pending array with modified entities
    //This entities have to be reinstalled and restarted
    //In case of being dependencies of type library, configured 
    //restart action will be none so it will be only installed
    for(entityIndex in entities){
	if(pending.indexOf(entities[entityIndex])==-1){
	    var aux = {
		"name": entities[entityIndex],
		"level": modules[entities[entityIndex]].level,
		"actions": getActionsToTake(entities[entityIndex],'none')
	    }; 
	    pending.push(aux);
	    pendingNames.push(entities[entityIndex]);
	}
    }
    
    //Look for dependencies and respective actions to take
    pendingIndex = pending.length-1;
    while(pending.length != 0){
	
	//Let's put the entity in the result array
	if(resultNames.indexOf(pendingNames[pendingIndex])==-1){
	    result.push(pending[pendingIndex]);
	    resultNames.push(pendingNames[pendingIndex]);
	}
	
	//Let's add its dependencies to result array
	for(depIndex in modules[pendingNames[pendingIndex]].dependencies){
	    var dependency = modules[pendingNames[pendingIndex]].dependencies[depIndex];

	    if(resultNames.indexOf(dependency.name)==-1){		
		result.push(
		{
		    "name": dependency.name,
		    "level": modules[dependency.name].level,
		    "actions": getActionsToTake(dependency.name,pending[pendingIndex].name)
		});    
		resultNames.push(dependency.name);
	    }
	}
	
	pending.splice(pendingIndex,1);
	pendingNames.splice(pendingIndex,1);
	pendingIndex = pending.length-1;
    }
    
    result = result.sort(function(a,b){return a.level - b.level})
    return result;    
}

//Replace values in installations commands
var buildCommand = function(command,location){

    command = command.replace('%production.keypath%', config.prodKeyPath);
    command = command.replace('%development.keypath%', config.prodKeyPath);
    command = command.replace('%location%', location);
    return command;

}

//Get entities location list
var getEntityLocations = function(entity){    
    switch(entity.type){
    case 'library':
	var locations = [];
	
	for(i in entity.dependencies){
	    locations = locations.concat(modules[entity.dependencies[i].name].location);
	}
	
	return locations.sort().filter(function(val,ind,arr){return (val != null && val!=arr[ind -1]) });
	break;
    default:
	return entity.location;
	break;

    }
}


//Builds deployment execution flow as a hash of intructions  
var getExecutionFlow = function(graph){

    var commands = {"updateRepo":[config.updateRepoAction], "copy":[],"install":[], "restart":[]};
    
    for(index in graph){
	node = graph[index];
	entity = modules[node.name];
	locations = getEntityLocations(entity);

	for(location in locations){
	    for(action in node.actions){
		commands[node.actions[action]].push(buildCommand(entity[node.actions[action]],locations[location]));
	    }
	}
    }
    
    return commands;
}


var saveRetryCommand = function(command){
    pendingRetryExecutions.push(command);
}

var initValues = function(){
    pendingRetryExecutions = [];
    pendingServerRestarts = [];
    retryCount = 0;
}

//Execute a bash command with a fork
var fork = function(command, callback){
    var date = new Date();
    var execOptions = {timeout: config.timeout, killSignal: 'SIGTERM'};
    
    var process = child.fork(__dirname+"/"+config.execChildFile);    
    
    process.on('message', function(message){
	
	if(message.code != null){
	    saveRetryCommand(command);
	}
	
	console.log("\n["+date+"] Ending process ["+process.pid+"] "+command+" with code " + JSON.stringify(message));
	process.kill('SIGTERM');

	callback();
    });

    process.on("SIGTERM", function() {
	process.exit();
    });    

    process.send({"command": command, "options": execOptions});
    	
}

//Executes several bash commands in parallel
var forkParallel = function(commands,successMessage,callback){
    var date = new Date();
    async.forEach(commands, fork
		  ,function(err) {
		      if(err != null && err.code !=null){
			  console.error("\n["+date+"] An error has occurred " + JSON.stringify(err));			 
			  callback(err);
		      }else{
			  console.log("\n["+date+"] "+successMessage); 	
			  callback(null);
		      }		      
		  });
}


//This function makes deployment server wait a little
//for servers to restart
var waitRestarts = function(callback){

    var date = new Date();
    console.log("\n["+date+"] Waiting for servers to restart with a "+config.restartTimeout+" milliseconds timeout"); 
    setTimeout(
	function(){
	    console.log("\n["+date+"] Already waited for servers"); 
	    callback();
	}
	,config.restartTimeout);	    
}


//Execute commands does the actual deployment
//by executing bash commnads
var executeCommands = function(commands, callback){
    
    var date = new Date();
        
    //console.log(commands["install"].map(function(command){ return simpleExec.bind(this,command)}));
    async.series([
	
	//Execute repo pull
	fork.bind(this,commands["updateRepo"][0]),

	//Execute copy commands
	forkParallel.bind(this,commands["copy"],"Executed copy instructions sucessfully"),

	//Execute install commands
	forkParallel.bind(this,commands["install"],"Executed install instructions sucessfully"),

	//Execute restart commands
	forkParallel.bind(this,commands["restart"],"Asked restart instructions execution"),

	//Wait some time for servers to restart
	waitRestarts.bind(this)

		
    ],function(err, results){
	
	if(err == null || err.code == null){
	    console.log("\n["+date+"] Pending instructions to execute " + pendingRetryExecutions);
	    console.log("\n["+date+"] All instructions ended execution"); 
	    callback(null);
	    return pendingRetryExecutions!=0;
	    
	}else{
	    callback(err);
	    console.error("\n["+date+"] There where errors in execution " +JSON.stringify(err)); 
	    return false;
	}
    });

}


//This function executes deployment instructions verifying
//if we have to retry deployment
var executeCommandsRetrying =  function(commands, callback){
    
    var date = new Date();
    pendingRetryExecutions = [];

    if(retryCount < config.retryCount && pendingServerRestarts.length!=0){
	retryCount++;
	console.log("Starting retry number " + retryCount);
	var res = tryToExecute(commands,callback);
	return executeCommands(commands,callback);
    }else{
	console.log("Finished retrying");
	return callback();
    }
    
}


//Setting up controller for GET on /
server.get('/', function(req, res){
    res.send("Gettint request "+ req.body);
});


//Setting up controller for POST on /message
server.post('/message' ,express.bodyParser(),function(request, response){
    
    var date = new Date();
    console.log("["+date+"] Arriving message "+JSON.stringify(request.body));

    if(request.body.messageType = "restart"){
	index = pendingServerRestarts.indexOf(request.body.entityName);
	if(index!=-1){
	    pendingServerRestarts.splice(index, 1);
	}
    }

    console.log("["+date+"] Pending servers for restart: "+pendingServerRestarts);
    
    //Process message
    response.send("Got message request from "+request.body.entityName);
}, function(err, request, response, next) { 
    console.log("An error has occurred processing the message..." + err);
    response.send("An error has occurred processing the message..." + err);
});



//Setting up controller on '/deployment' url post

//This is server's main flow. In case of getting a valid
//request from a github's production push, builds a structure
//to make production enviroment deployment 
server.post('/deployment', express.bodyParser(), function(req, res) {
    
    var date = new Date();
    var request  = JSON.parse(req.body.payload);
    console.log("["+date+"] Parsing request "+JSON.stringify(request)+"\n");
    
    if(isRequestFromGitHubRepository(request, config)){
	console.log("["+date+"] This push is from github's " + config.repositoryName + " repository");

	if(isAuthorizedProductionChange(request, config)){	    
	    console.log("["+date+"] This is an authorized production branch push");
	    
	    servers = getModifiedEntities(request);
	    console.log("["+date+"] List of modified entities: " + servers);	    

	    graph = getDependencySubGraph(servers);
	    console.log("["+date+"] Dependency subgraph found: " + graph.map(JSON.stringify));	    
	    
	    commands = getExecutionFlow(graph);
	    async.series([
		
		//Perform deployment execution
		executeCommands.bind(this,commands),
			
		//Send email notification with deployment report
		sendReportEmail.bind(this, " ", pendingRetryExecutions, servers, commands, request),
	
		//Initialize server global variables
		initValues.bind(this)
	    
	    ], function(err, results){
		if(err == null || err.code == null){
		    console.log("\n["+date+"] Deployment finished and report notification sent"); 
		}else{
		    console.error("\n["+date+"] There where errors in deployment execution " +JSON.stringify(err)); 
		}
	    });
	    
	    
	    console.log("["+date+"] Proccessing...");
	    res.send("Proccessing...\n");
	    
	}else{
	    console.error("["+date+"] This request does not correspond to an authorized production change " + JSON.stringify(request.pusher)+"-"+JSON.stringify(request.ref));	    
	    res.send("["+date+"] This request does not correspond to an authorized production change " + JSON.stringify(request.pusher)+"-"+JSON.stringify(request.ref));	    
	}
	
    }else{
	console.error("["+date+"] This request does not have git hub hook's format " + JSON.stringify(req.body));
	res.send("["+date+"] This request does not have git hub hook's format " + JSON.stringify(req.body));
    }
    
}, function(err, req, res, next) {
    console.error("An error has occurred processing the request..." + err);
    res.send("An error has occurred processing the request..." + err);
});

//Starting listener on configured port
server.listen(config.rpc.port);
console.log('Deployment server running on port "' + config.rpc.port);