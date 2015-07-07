/*
	This code handle the "modify" event. The process is as follows:
		- clone the repo
		- fetch (and pruning)
		- checkout the branch. If it already exists, we merge potential changes from the production branch
		- update the module ref in Puppetfile if needed
		- commit the changes in Puppetfile if needed
		- push the changes upstream if needed
		- invoke r10k
			- update the module in 'feature' environment (most of the time)
			- update all modules in 'feature' environment if there were changes merged from the 'production' branch so that our 'feature' environment reflects those changes
*/

var promisify = require('promisify-node');
var fse = promisify(require('fs-extra'));
var logger = require('../logger');
var GU = require('./git_utils');
var RD = require('../r10k/rundeck');


/*
	eventData: object containing the name of the branch, the name of the module and the type of event
	cbk: represents the "done" callback used by kue to know when an error occured during job processing
*/ 
var runModify = function *(eventData, cbk) {

	var now = Date.now();
	var fullDeploymentNeeded = false;
	var gitdir = '/var/tmp/puppetfile_repo_'+now;
	var gitopts = { cwd: gitdir };
	var pfile = gitdir+'/Puppetfile';
	var branchName = eventData.branch;
	var moduleName = eventData.reponame;
	var rundeck_data = { "branch": branchName, "module": moduleName };
	var module_regex_builder = '('+moduleName+'\\.git[\'"],\\s*:ref\\s*=>\\s*[\'"])[^\'"]+([\'"]\\s*)$';
	var module_ref_regex_builder = '('+moduleName+'\\.git[\'"],\\s*:ref\\s*=>\\s*[\'"])'+branchName+'([\'"]\\s*)$';
	var module_regex = new RegExp(module_regex_builder, 'gm');
	var module_ref_regex = new RegExp(module_ref_regex_builder, 'gm');

	try {

		logger.info('Entering "modify_action" process for branch '+branchName+' of module '+moduleName);

		// Clone the repository
		yield* GU.clone(gitdir);

		// Fetch from remote
		yield* GU.fetch(gitopts);

		// Checking if branch already exists on remote and checkout
		logger.debug('Checking if branch "'+branchName+'" exists on remote');
		var branchExist = yield* GU.branchExist(branchName, gitopts);

		if (branchExist) {
			/*
				If changes from the 'production' branch were merged into our 'feature' branch,
				we need to tell r10k to update the whole environment. Otherwise, we'll simply update
				the module in the 'feature' environment.
			*/
			fullDeploymentNeeded = yield* GU.checkoutExisting(branchName, gitopts);
		}
		else {
			// This case should never happen except when someone manually messed up with your Puppetfile
			yield* GU.checkoutNew(branchName, gitopts);

			// If the 'feature' branch doesn't exist on remote, we'll have to deploy the entire 'feature' environment
			fullDeploymentNeeded = true;
		}

		// We update the reference for the module in the Puppetfile
		var content = yield fse.readFile(pfile, { encoding: 'utf-8' });
		var moduleDefined = module_regex.test(content);

		logger.debug('Is module '+moduleName+' defined in Puppetfile: '+moduleDefined);

		if (!moduleDefined) {
			// At the moment, we don't handle newly created modules not referenced in Puppetfile
			throw new Error('NEW MODULE NOT REFERENCED IN PUPPETFILE: You need to add it manually to the Puppetfile');
		}

		/*
			Module ref should already be pointing to "feature" branch as it's a "modify" event.
			But if it's not the case for some reason, we have to update ref accordingly like we do in the "create" event.
		*/
		var isRefOK = module_ref_regex.test(content);

		if (!isRefOK) {
			
			logger.debug('Reference of module '+moduleName+' is not pointing to branch '+branchName+' for some reason. Updating it');
			var new_content = content.replace(module_regex, '$1'+branchName+'$2');
			logger.debug(new_content);
			
			yield fse.writeFile(pfile, new_content, { encoding: 'utf-8' });
			logger.debug('Puppetfile updated');

			// Commiting changes
			yield* GU.commit(moduleName, branchName, gitopts);

		}

		/*
			Push only if needed, that is:
				- when there were changes merged from the 'production' branch to the 'feature' branch
				- or when the module ref was updated (see above)
				- or when both occured
		*/

		if (!isRefOK || fullDeploymentNeeded) {

			logger.debug('Branch '+branchName+' has been updated. Push required');			
		
			// Pushing changes to remote
			yield* GU.push(branchName, gitopts);

		}

		/*
			Fully deploy environment with r10k if there were changes merged from the 'production' branch.
			Otherwise simply update the module in the 'feature' environment
		*/
		if (fullDeploymentNeeded) {
			// r10k deploy environment <feature_env> --puppetfile
			logger.info('Deploy all modules in environment '+branchName+' using r10k');
			rundeck_data.type = 'deploy_env';
		}
		else {
			// r10k deploy module -e <feature_env> <module>
			logger.info('Update module '+moduleName+' in environment '+branchName+' using r10k');
			rundeck_data.type = 'deploy_mod';
		}

		// Launch Rundeck job
		var rd_job_status = yield* RD.runJob(rundeck_data);

		// Removing temp directory
		logger.debug('Removing temp dir: '+gitdir);
		yield fse.remove(gitdir);
		
		logger.info('Processing branch '+branchName+' of module '+moduleName+' '+rd_job_status);

		// Return the kue "done" callback with null to indicate a successful job
		return cbk(null);

	} catch(err) {

		// Remove temp dir even if there's an error so we save disk space
		yield fse.remove(gitdir);

		// Return the kue "done" callback with the error to indicate a failed job
		return cbk(err);

	}
}

module.exports = {
	runModify: runModify
}