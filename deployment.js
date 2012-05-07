#!/usr/bin/env node
// # The *Deployment* Server

// Load vendor modules
var express = require('express');
var path = require('path');
var fs = require('fs');

// Load configuration files
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

//Search the corresponding module for each entity changed
var getMappedEntity = function(val){
    
    //We are not interested in file names, only folders
    var array = val.split("/");
    var rest =array.splice(0,array.length -1);
    val = rest.join("/");

    for(mod in modules){
	if(val.indexOf(mod)!= -1){
	    return mod;
	};
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
   
    //removing duplicates
    commitModules = commitModules.sort().filter(function(val,index,ar){return  (val != ar[index-1]);});
    
    //Getting affected entities
    affetedEntities = commitModules.map(getMappedEntity);
    affetedEntities = affetedEntities.filter(function(val){return val != null});

    return affetedEntities;
}

/*
Get dependency subGraph: Given a set of modified entities
we want to build a graph containing the information to execute
deployment.
*/
var getDependencySubGraph = function(entities){
	
    var result = [];
    var subgraph = [];
    var pending = entities;
    var ent = pending.length -1;

    //build complete dependencies array
    while(pending.length != 0){

	if(result.indexOf(pending[ent])==-1){
	    result.push(pending[ent]);
	}
	
	for(dep in modules[pending[ent]].dependencies){
	    if(pending.indexOf(modules[pending[ent]].dependencies[dep].name)==-1){
		pending.push(modules[pending[ent]].dependencies[dep].name);
	    }
	}
	
	pending.splice(ent,1);
	ent = pending.length-1;
    }

    //build objects from dependencies
    for(res in result){
	subgraph.push(modules[result[res]]);
    }
    
    //sort by level in graph
    subgraph = subgraph.sort(function(a,b){return a.level - b.level});
    return subgraph;
    
}

//Setting up controller for GET on /
server.get('/', function(req, res){
    res.send("Gettint request "+ req.body);
});

//Setting up controller on '/deployment' url post
server.post('/deployment', express.bodyParser(), function(req, res) {

    var date = new Date();
    console.log("["+date+"] Arriving request "+JSON.stringify(req.body)+"\n");

    if(isRequestFromGitHubRepository(req.body, configDeployData)){
	console.log("["+date+"] This push is from github's " + configDeployData.repositoryName + " repository");

	if(isAuthorizedProductionChange(req.body, configDeployData)){	    
	    console.log("["+date+"] This is an authorized production branch push");
	    
	    servers = getModifiedEntities(req.body);
	    console.log("["+date+"] List of modified entities: " + servers);	    

	    graph = getDependencySubGraph(servers);
	    console.log("["+date+"] Dependency graph found: " + graph.map(JSON.stringify));	    
	    
	    try{
		//execute scripts
	    }catch(err){
		
	    }
	    
	    console.log("["+date+"] Proccessing...");
	    res.send("Proccessing...\n");
	    
	}else{
	    console.log("["+date+"] This request does not correspond to an authorized production change " + JSON.stringify(req.body));	    
	    res.send("["+date+"] This request does not correspond to an authorized production change " + JSON.stringify(req.body));	    
	}
	
    }else{
	console.log("["+date+"] This request does not have git hub hook's format " + JSON.stringify(req.body));
	res.send("["+date+"] This request does not have git hub hook's format " + JSON.stringify(req.body));
    }
    
}, function(err, req, res, next) {
    console.log("An error has occurred processing the request..." + err);
    res.send("An error has occurred processing the request..." + err);
});

//Starting listener on configured port
server.listen(config.rpc.port);
console.log('Deployment server running on port "' + config.rpc.port);
