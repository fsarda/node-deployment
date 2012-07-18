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
var retryCount = 0;
var sesClient = aws.createSESClient(config.SES.key, config.SES.secret);
var servers = [];
var restartDependency = {};

//Setting up server configuration
server.configure(function(){
    server.use(express.favicon());
    server.use(express.logger('dev'));
    server.use(express.methodOverride());
    server.use(server.router);
    
});


//Send report email
var sendReportEmail = function(message,  entities, instructions, commit, callback){

    var textBody ="A deployment process has been executed with the following characteristics: \n"+
	"Commit id: " + lastCommitInstalled()+"\n"+
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
    textBody += "\n\nServers not restarted: " +pendingServerRestarts+"\n";
	

    var htmlBody ="A production deployment has been executed with the following characteristics: <br/> "+
	"<span style='font-weight: bold; text-decoration: underline;'>Commit id:</span> <a href='https://github.com/jsalcedo/Agrosica/commit/"+commit+"'>" + commit+"</a><br/>"+
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
    htmlBody += "<br/><span style='font-weight: bold; text-decoration: underline;'>Servers not restarted:</span> " +pendingServerRestarts+"<br/>";
    

    ////console.log(textBody);
    ////console.log(htmlBody);
	
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
	    //console.log(result);
	    return callback(new Error("There was an error sending the report email"));
	}
	return callback({success: true});
    });*/

    return callback({success: true});
};


//Verifies if the request comes from  github
var isRequestFromGitHubRepository = function(request, configData){
    return request.repository!=undefined && configData.repoInfo.repositoryName.toUpperCase() === request.repository.name.toUpperCase();
}

//Verifies conditions for running automated deployment
var isAuthorizedProductionChange = function(request, configData){
    
    //Check if is a production branch push
    var response = request.ref.indexOf(configData.repoInfo.productionBranch)!=-1;
    
    //Not everyone is authorized. Let's check if the pusher is
    if(configData.repoInfo.authorizedCommitUsers.length!=0){
	response = response && configData.repoInfo.authorizedCommitUsers.indexOf(request.pusher.name) != -1;
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
var getModifiedEntities = function(message,callback){

    var date = new Date();
    var affectedEntities = [];    
    var lastCommit = getLastCommit();

    //If we dont have a last commit installed, then we install everythig
    if(lastCommit == null){
	var modulesList = Object.keys(modules);

	for(i in modulesList){
	    affectedEntities.push(modulesList[i]);
	}

	callback(null,affectedEntities);
	console.log("["+date+"] Modified entities found: " + affectedEntities);
	return affectedEntities;
    
    }else{

	fork(config.repoInfo.diffRepoAction.replace("%hash%",lastCommit), function(err,message){
	    var commitModules = [];
	    commitModules = message.stdout.split("\n");
	    
	    //Getting affected entities
	    affectedEntities = commitModules.map(getMappedEntity);
	    affectedEntities = affectedEntities.sort();
	    affectedEntities = affectedEntities.filter(function(val,ind,arr){
		return (val != null && val.length!=0 && val!=arr[ind -1]) 
	    });

	    callback(null,affectedEntities);
	    console.log("["+date+"] Modified entities found: " + affectedEntities);
	    return affectedEntities;
	});
    }

}

var getActionsToTake = function(dependency, entity){

    var type = (entity==='none')?"initial":modules[entity].dependencies.filter(function(val){return val.name==dependency})[0].type;
    var action = "";
    var dependingEntity = modules[dependency];
    

    switch(type){
    case "hard":
	if(dependingEntity.type==="server"){
	    action = ["restart"];
	    if(pendingServerRestarts.indexOf(dependency) == -1){pendingServerRestarts.push(dependency);}
	}else{
	    action = ["copy","install"];
	}	
	break;
    case "soft":
	break;
    case "initial":
	if(dependingEntity.type==="server"){
	    action = ["copy","install","restart"];
	    if(pendingServerRestarts.indexOf(dependency) == -1){pendingServerRestarts.push(dependency);}
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

/*
Get dependency subGraph: Given a set of modified entities
we want to build a graph containing the information to execute
deployment.
*/
var getDependencySubGraph = function(entities, callback){
    
    var date = new Date();
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
		"actions": getActionsToTake(entities[entityIndex],'none'),
		"dependsOn": [],
	    }; 

	    pending.push(aux);
	    pendingNames.push(entities[entityIndex]);
	    result.push(aux);
	    resultNames.push(entities[entityIndex]);
	}
    }
    
    //Look for dependencies and respective actions to take
    pendingIndex = pending.length-1;
    while(pending.length != 0){
	
	//Let's add its dependencies to result array
	for(depIndex in modules[pendingNames[pendingIndex]].dependencies){
	    var dependency = modules[pendingNames[pendingIndex]].dependencies[depIndex];
	    var indexResult = resultNames.indexOf(dependency.name);

	    //If entity doesn't exist in resulting array,
	    //we add it
	    if(indexResult==-1){		

		var depInfo = {
		    "name": dependency.name,
		    "level": modules[dependency.name].level,
		    "actions": getActionsToTake(dependency.name,pending[pendingIndex].name),
		    "dependsOn": [modules[pendingNames[pendingIndex]].type == "server"?pendingNames[pendingIndex]:null].filter(
			function(val,ind,arr){
			    return (val != null && val.length!=0 && val!=arr[ind -1]) 
			})
		};

		result.push(depInfo);    
		resultNames.push(dependency.name);
	    }

	    //If already exists, maybe has a different type of dependency
	    //we add the possible new actions to take
	    else{
		result[indexResult].actions = result[indexResult].actions.concat(getActionsToTake(dependency.name, pending[pendingIndex].name)).sort().filter(function(val,ind,arr){
		    return (val != null && val.length!=0 && val!=arr[ind -1]) 
		});
		
		if(modules[pendingNames[pendingIndex]].type == "server"){
		    result[indexResult].dependsOn.push(pendingNames[pendingIndex]);
		}
	    }
	}
	
	pending.splice(pendingIndex,1);
	pendingNames.splice(pendingIndex,1);
	pendingIndex = pending.length-1;
    }
    
    result = result.sort(function(a,b){return a.level - b.level})
    console.log("["+date+"] Dependency subgraph found: " + result.map(JSON.stringify));	    
    callback(null,result);
    return result;    
}

//Replace values in installation commands
var buildCommand = function(command,location){

    command = command.replace('%production.keypath%', config.prodKeyPath);
    command = command.replace('%development.keypath%', config.devKeyPath);
    command = command.replace('%location%', location);
    command = command.replace('%rootRepo%', config.repoInfo.rootRepo);

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
var getExecutionFlow = function(graph, action){

    var commands = [];

    for(index in graph){
	node = graph[index];
	entity = modules[node.name];
	locations = getEntityLocations(entity);

	for(location in locations){
	    if(node.actions.indexOf(action) != -1){
		var command = buildCommand(entity[action],locations[location]);
		if(commands.indexOf(command)==-1){
		    commands.push(command);
		}
	    }
	}
    }

    return commands;
}

//initialize global values once deployment process has finished
var initValues = function(){
    pendingServerRestarts = [];
    retryCount = 0;
}

//Execute a bash command with a fork
var fork = function(command, callback){
    var date = new Date();
    var execOptions = {timeout: config.execInfo.timeout, killSignal: 'SIGTERM', env: {"PATH": config.execInfo.userPATH}};
    
    if(command.length != 0){
	
	var process = child.fork(__dirname+"/"+config.execInfo.execChildFile);    
	
	process.on('message', function(message){
	    
	    if(message.code != null){
		callback(message.code);
	    }

	    
	    console.log("\n["+date+"] Ending process ["+process.pid+"] "+command+" with code " + JSON.stringify(message));
	    process.kill('SIGTERM');
	    
	    callback(null, message);
	    return message;
	    
	});
	
	process.on("SIGTERM", function() {
	    process.exit();
	});    
	
	process.send({"command": command, "options": execOptions, "retryCount": config.execInfo.retryCount});
    
    }else{
	callback(null, {"code":null, "stdout": "", "stderr": "" });
    }
    	
}

//Executes several bash commands in parallel or serial
var executeSeveral = function(commands,mode,successMessage,callback){
    var date = new Date();
    var func;

    switch(mode){
    case "serial":
	func = async.forEachSeries;
	break;
    case "parallel":
	func = async.forEach;
	break;
    default:
	func = async.forEach;
	break;
    }

    func(commands, fork
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

//This function uses async.auto to generate
//the dependency tree execution for services
//restart
var executeRestart = function(graph, callback){
    
    var funcObject = {};
    
    for(index in graph){
	if(graph[index].actions.indexOf("restart")!=-1){
	    funcObject[graph[index].name] = graph[index].dependsOn.concat([executeSeveral.bind(this,getExecutionFlow([graph[index]], "restart"), "parallel","Executed restart instructions for "+graph[index].name+" server")]);
	}
    }
    
    console.log("Dependency restarts: " + JSON.stringify(funcObject));

    async.auto(funcObject, function(err, results){
	console.log("Finished initiating restart instructions "+err+" "+results);
    });
    
    callback(null);
}

//This function makes deployment server wait a little
//for servers to restart
var waitRestarts = function(callback){

    var date = new Date();
    console.log("\n["+date+"] Waiting for servers to restart with a "+config.execInfo.restartTimeout+" milliseconds timeout"); 
    setTimeout(
	function(){
	    console.log("\n["+date+"] Already waited for servers. Pending for restart are: "+pendingServerRestarts); 
	    callback();
	}	,config.execInfo.restartTimeout);	    
}


//Execute commands does the actual deployment
//by executing bash commnads
var executeCommands = function(graph, callback){
    
    var date = new Date();

    async.series([
	
	//Execute copy commandsfunction 
	executeSeveral.bind(this,getExecutionFlow(graph,"copy"),"parallel","Executed copy instructions sucessfully"),

	//Execute install commands 
	executeSeveral.bind(this,getExecutionFlow(graph,"install"),"parallel","Executed install instructions sucessfully"),

	//Execute restart commands
	executeRestart.bind(this,graph),

	//Wait some time for servers to restart
	waitRestarts.bind(this)

		
    ],function(err, results){
	
	if(err == null || err.code == null){
	    console.log("\n["+date+"] Result " + results);
	    callback(null);
	    return true;
	    
	}else{
	    console.error("\n["+date+"] There where errors in execution " +JSON.stringify(err)); 
	    callback(err);
	    return false;
	}
    });

}


//Update file that contains last commit installed
var updateLastInstalled = function(callback){
    
    var date = new Date();
    
    //Get last hash from git log
    var commitJSON = fork(buildCommand(config.repoInfo.lastCommitCommand), function(err,message){
	
	//Write to file
	fs.writeFile(config.repoInfo.lastCommitInstalled, '{"commit":"'+message.stdout+'"}', function (err) {
	    if(err){
		console.log("["+date+"] An error has occurred writing file "+config.repoInfo.lastCommitInstalled);
		callback(err);
		return;
	    };
	    callback(null);
	    console.log("["+date+"] Last commit successfully saved: "+message.stdout);
	});
    });
} 

//Get last commit installed from file. If file
//does not exist, it will install everything
var getLastCommit = function(){
    
    var date = new Date();

    try{
	var lastCommit = JSON.parse(fs.readFileSync(path.join(__dirname + "/"+config.repoInfo.lastCommitInstalled), "utf8")).commit;
	console.log("["+date+"] Last commit installed: " + lastCommit);
	return lastCommit;
    }catch(error){
	console.log("["+date+"] Error getting file " + config.repoInfo.lastCommitInstalled +". Installing all services.");
	return null;
    }
}


//Function to update repository
var updateRepo = function(callback){
    fork(buildCommand(config.repoInfo.updateRepoAction), function(err,message){
	if(err){
	    callback(err);
	    return message;
	};
	callback(null, message);
	return message;
    });
}


//Main function for updating and installing changes
var install = function(callback){

    var date = new Date();
    async.waterfall([
	
	//Execute repo pull
	updateRepo,
	
	//Determine Modified Entities
	getModifiedEntities,
	
	//Determine dependency subgraph
	getDependencySubGraph,
	
	//Perform deployment execution
	executeCommands,
	    
	//Update file with last commit installed
	updateLastInstalled
	
    ], function(err, results){
	if(err == null || err.code == null){
	    console.log("\n["+date+"] Finished services install process"); 
	}else{
	    console.error("\n["+date+"] There where errors in deployment execution " +JSON.stringify(err)); 
	}
	callback(null);

    });
}

/*
  Main function of deployment process. Executes install, 
  notification and ending process in series
 */
var executeDeployment = function(){
    async.series([
	//install services
	install,
	
	//Send email notification with deployment report
	//sendReportEmail.bind(this, " ", servers, commands, lastCommit),
	
	//Initialize server global variables
	initValues.bind(this)
    ], function(err, results){
	if(err == null || err.code == null){
	    console.log("\n["+date+"] Finished services install process"); 
	}else{
	    console.error("\n["+date+"] There where errors in deployment execution " +JSON.stringify(err)); 
	}
    });
	

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
    ////console.log("An error has occurred processing the message..." + err);
    response.send("An error has occurred processing the message..." + err);
});




//Setting up controller on '/deployment' url post

//In case of getting a valid request from a github's 
//production push, builds a structure to make 
//production enviroment deployment 
server.post('/deployment', express.bodyParser(), function(req, res) {
    
    var date = new Date();
    var request  = JSON.parse(req.body.payload);
    console.log("["+date+"] Parsing request "+JSON.stringify(request)+"\n");
    
    if(isRequestFromGitHubRepository(request, config)){
	console.log("["+date+"] This push is from github's " + config.repoInfo.repositoryName + " repository");

	if(isAuthorizedProductionChange(request, config)){	    
	    console.log("["+date+"] This is an authorized production branch push");
	    
	    executeDeployment();
	    
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

//Execute deployment process
executeDeployment();
