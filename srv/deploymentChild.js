var childl = require('child_process');
var date = new Date();
var commandReceived = {};
var retryCount = 0;

//Process receives a message from parent 
process.on('message', function(m) {
  //  console.log("\n["+date+"] Executing child process with command " + m.command)
    commandReceived = m;
    childl.exec(m.command , m.options, sendToParent);
});


//Sends message to parent process with result of execution
function sendToParent(error, stdout, stderr){

//    console.log("\n["+date+"] Processing ending exec with response {" +error + ", "+commandReceived.command+"}");

    // if(retryCount < commandReceived.retryCount && (error != null || (stderr != "" && stderr != null))){
    // 	retryCount++;
    // 	console.log("\n["+date+"] Retrying  " + commandReceived.command+" with attempt "+retryCount);
    // 	childl.exec(commandReceived.command , commandReceived.options, sendToParent);
    // }else{
    // 	if(stderr != "" && stderr != null){
    // 	    process.send({ "code":stderr , "stdout": stdout, "stderr": stderr });    
    // 	}else{
    process.send({ "code":error , "stdout": stdout, "stderr": stderr });    
    // 	}
    // }
}
