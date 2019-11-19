/*!
 * VisualEditor DataModel TransactionProcessor class.
 *
 * @copyright 2011-2019 VisualEditor Team and others; see http://ve.mit-license.org
 */

/**
 * DataModel transaction processor.
 *
 * This class reads operations from a transaction and applies them one by one. It's not intended
 * to be used directly; use {ve.dm.Document#commit} instead.
 *
 * NOTE: Instances of this class are not recyclable: you can only call .process() on them once.
 *
 * @class
 * @param {ve.dm.Document} doc Document
 * @param {ve.dm.Transaction} transaction Transaction
 * @param {boolean} isStaging Transaction is being applied in staging mode
 * @constructor
 */
ve.dm.TransactionProcessor = function VeDmTransactionProcessor( doc, transaction, isStaging ) {
	// Properties
	this.document = doc;
	this.transaction = transaction;
	this.operations = transaction.getOperations();
	this.isStaging = isStaging;
	this.modificationQueue = [];
	this.rollbackQueue = [];
	this.eventQueue = [];
	// Linear model offset that we're currently at. Operations in the transaction are ordered, so
	// the cursor only ever moves forward.
	this.cursor = 0;
	// Adjustment that needs to be added to linear model offsets in the original linear model
	// to get offsets in the half-updated linear model. Arguments to queued modifications all use
	// unadjusted offsets; this is needed to adjust those offsets after other modifications have been
	// made to the linear model that have caused offsets to shift.
	this.adjustment = 0;
	// State tracking for unbalanced replace operations
	this.replaceRemoveLevel = 0;
	this.replaceInsertLevel = 0;
	this.replaceMinInsertLevel = 0;
	this.retainDepth = 0;
	this.balanced = true;
	this.treeModifier = null;
};

/* Static members */

/* See ve.dm.TransactionProcessor.modifiers */
ve.dm.TransactionProcessor.modifiers = {};

/* See ve.dm.TransactionProcessor.processors */
ve.dm.TransactionProcessor.processors = {};

/* Methods */

/**
 * Execute an operation.
 *
 * @private
 * @param {Object} op Operation object to execute
 * @throws {Error} Operation type is not supported
 */
ve.dm.TransactionProcessor.prototype.executeOperation = function ( op ) {
	if ( Object.prototype.hasOwnProperty.call( ve.dm.TransactionProcessor.processors, op.type ) ) {
		ve.dm.TransactionProcessor.processors[ op.type ].call( this, op );
	} else {
		throw new Error( 'Invalid operation error. Operation type is not supported: ' + op.type );
	}
};

/**
 * Process all operations.
 *
 * When all operations are done being processed, the document will be synchronized.
 *
 * @private
 */
ve.dm.TransactionProcessor.prototype.process = function () {
	var i, completed;

	// Ensure the pre-modification document tree has been generated
	this.document.getDocumentNode();

	// First process each operation to gather modifications in the modification queue.
	// If an exception occurs during this stage, we don't need to do anything to recover,
	// because no modifications were made yet.
	for ( i = 0; i < this.operations.length; i++ ) {
		this.executeOperation( this.operations[ i ] );
	}
	if ( !this.balanced ) {
		throw new Error( 'Unbalanced set of replace operations found' );
	}

	// Apply the queued modifications
	try {
		completed = false;
		this.treeModifier = null;
		this.applyModifications();
		this.treeModifier = new ve.dm.TreeModifier( this.document, this.transaction );
		this.treeModifier.process();
		completed = true;
	} finally {
		// Don't catch and re-throw errors so that they are reported properly
		if ( !completed ) {
			// Restore the linear model to its original state
			if ( this.treeModifier ) {
				this.treeModifier.undoLinearSplices();
			}
			this.rollbackModifications();
			// The tree may have been left in some sort of half-baked state, so rebuild it
			// from scratch
			this.document.rebuildTree();
		}
	}
	// Mark the transaction as committed
	this.transaction.markAsApplied();
	// Emit events in the queue
	this.emitQueuedEvents();
};

/**
 * Queue a modification.
 *
 * @private
 * @param {Object} modification Object describing the modification
 * @param {string} modification.type Name of a method in ve.dm.TransactionProcessor.modifiers
 * @param {Array} [modification.args] Arguments to pass to this method
 * @throws {Error} Unrecognized modification type
 */
ve.dm.TransactionProcessor.prototype.queueModification = function ( modification ) {
	if ( typeof ve.dm.TransactionProcessor.modifiers[ modification.type ] !== 'function' ) {
		throw new Error( 'Unrecognized modification type ' + modification.type );
	}
	this.modificationQueue.push( modification );
};

/**
 * Queue an undo function. If an exception is thrown while modifying, #rollbackModifications will
 * invoke these functions in reverse order.
 *
 * @param {Function} func Undo function to add to the queue
 */
ve.dm.TransactionProcessor.prototype.queueUndoFunction = function ( func ) {
	this.rollbackQueue.push( func );
};

/**
 * Apply all modifications queued through #queueModification, and add their rollback functions
 * to this.rollbackQueue.
 *
 * @private
 */
ve.dm.TransactionProcessor.prototype.applyModifications = function () {
	var i, len, modifier, modifications = this.modificationQueue;
	this.modificationQueue = [];
	for ( i = 0, len = modifications.length; i < len; i++ ) {
		modifier = ve.dm.TransactionProcessor.modifiers[ modifications[ i ].type ];
		modifier.apply( this, modifications[ i ].args || [] );
	}
};

/**
 * Roll back all modifications that have been applied so far. This invokes the callbacks returned
 * by the modifier functions.
 *
 * @private
 */
ve.dm.TransactionProcessor.prototype.rollbackModifications = function () {
	var i, rollbacks = this.rollbackQueue;
	this.rollbackQueue = [];
	for ( i = rollbacks.length - 1; i >= 0; i-- ) {
		rollbacks[ i ]();
	}
};

/**
 * Queue an event to be emitted on a node.
 *
 * Duplicate events will be ignored only if all arguments match exactly (i.e. are reference-equal).
 *
 * @private
 * @param {ve.dm.Node} node
 * @param {string} event Event name
 * @param {...Mixed} [args] Additional arguments to be passed to the event when fired
 */
ve.dm.TransactionProcessor.prototype.queueEvent = function ( node ) {
	var args = Array.prototype.slice.call( arguments, 1 );
	this.eventQueue.push( {
		node: node,
		args: args.concat( this.transaction )
	} );
};

/**
 * Emit all events queued through #queueEvent.
 *
 * @private
 */
ve.dm.TransactionProcessor.prototype.emitQueuedEvents = function () {
	var i, event,
		queue = this.eventQueue;

	function isDuplicate( otherEvent ) {
		return otherEvent.node === event.node &&
			otherEvent.args.every( function ( arg, index ) {
				return arg === event.args[ index ];
			} );
	}

	this.eventQueue = [];
	for ( i = 0; i < queue.length; i++ ) {
		event = queue[ i ];
		// Check if this event is a duplicate of something we've already emitted
		if ( !queue.slice( 0, i ).some( isDuplicate ) ) {
			event.node.emit.apply( event.node, event.args );
		}
	}
};

/**
 * Advance the main data cursor.
 *
 * @private
 * @param {number} increment Number of positions to increment the cursor by
 */
ve.dm.TransactionProcessor.prototype.advanceCursor = function ( increment ) {
	this.cursor += increment;
};

/**
 * Modifier methods.
 *
 * Each method executes a specific type of linear model modification, updates the model tree, and
 * returns a function that undoes the linear model modification, in case we need to recover the
 * previous linear model state. (The returned undo function does not undo the model tree update.)
 * Methods are called in the context of a transaction processor, so they work similar to normal
 * methods on the object.
 *
 * @class ve.dm.TransactionProcessor.modifiers
 * @singleton
 */

/**
 * Splice data into / out of the data array, and synchronize the tree.
 *
 * For efficiency, this function modifies the splice operation objects (i.e. the elements
 * of the splices array). It also relies on these objects not being modified by others later.
 *
 * @param {Object[]} splices Array of splice operations to execute. Properties:
 *  {number} splices[].offset Offset to remove/insert at (unadjusted)
 *  {number} splices[].removeLength Number of elements to remove
 *  {Array} splices[].insert Data to insert; for efficiency, objects are inserted without cloning
 */
ve.dm.TransactionProcessor.modifiers.splice = function ( splices ) {
	var i, s,
		lengthDiff = 0,
		data = this.document.data;

	// We're about to do lots of things that can go wrong, so queue an undo function now
	// that undoes all splices that we got to
	this.queueUndoFunction( function () {
		var i, s;
		for ( i = splices.length - 1; i >= 0; i-- ) {
			s = splices[ i ];
			if ( s.removedData !== undefined ) {
				data.batchSplice( s.offset, s.insert.length, s.removedData );
			}
		}
	} );

	// Apply splices to the linmod and record how to undo them
	for ( i = 0; i < splices.length; i++ ) {
		s = splices[ i ];

		// Adjust s.offset for previous modifications that have already been synced to the tree;
		// this value is used by the tree sync code later.
		s.treeOffset = s.offset + this.adjustment;
		// Also adjust s.offset for previous iterations of this loop (i.e. unsynced modifications);
		// this is the value we need for the actual array splice.
		s.offset = s.treeOffset + lengthDiff;

		// Perform the splice and put the removed data in s, for the undo function
		s.removedData = data.batchSplice( s.offset, s.removeLength, s.insert );
		lengthDiff += s.insert.length - s.removeLength;
	}
	this.adjustment += lengthDiff;
};

/**
 * Set an attribute at a given offset.
 *
 * @param {number} offset Offset in data array (unadjusted)
 * @param {string} key Attribute name
 * @param {Mixed} value New attribute value
 */
ve.dm.TransactionProcessor.modifiers.setAttribute = function ( offset, key, value ) {
	var item, oldValue, node,
		data = this.document.data;
	offset += this.adjustment;

	item = data.getData( offset );
	oldValue = item.attributes && item.attributes[ key ];
	data.setAttributeAtOffset( offset, key, value );
	this.queueUndoFunction( function () {
		data.setAttributeAtOffset( offset, key, oldValue );
	} );

	node = this.document.getDocumentNode().getNodeFromOffset( offset + 1 );
	this.queueEvent( node, 'attributeChange', key, oldValue, value );
	this.queueEvent( node, 'update', this.isStaging );
};

/**
 * Processing methods.
 *
 * Each method is specific to a type of action. Methods are called in the context of a transaction
 * processor, so they work similar to normal methods on the object.
 *
 * @class ve.dm.TransactionProcessor.processors
 * @singleton
 */

/**
 * Execute a retain operation.
 *
 * Called within the context of a transaction processor instance; moves the cursor by op.length
 *
 * @method
 * @param {Object} op Operation object:
 * @param {number} op.length Number of elements to retain
 */
ve.dm.TransactionProcessor.processors.retain = function ( op ) {
	var i, type, retainedData;
	if ( !this.balanced ) {
		// Track the depth of retained data when in the middle of an unbalanced replace
		retainedData = this.document.getData( new ve.Range( this.cursor, this.cursor + op.length ) );
		for ( i = 0; i < retainedData.length; i++ ) {
			type = retainedData[ i ].type;
			if ( type !== undefined ) {
				this.retainDepth += type.charAt( 0 ) === '/' ? -1 : 1;
			}
		}
	}
	this.advanceCursor( op.length );
};

/**
 * Execute an attribute operation.
 *
 * This method is called within the context of a transaction processor instance.
 *
 * This sets the attribute named `op.key` on the element at `this.cursor` to `op.to`, or unsets it if
 * `op.to === undefined`. `op.from` is not checked against the old value, but is used instead of `op.to`
 * in reverse mode. So if `op.from` is incorrect, the transaction will commit fine, but won't roll
 * back correctly.
 *
 * @method
 * @param {Object} op Operation object
 * @param {string} op.key Attribute name
 * @param {Mixed} op.from Old attribute value, or undefined if not previously set
 * @param {Mixed} op.to New attribute value, or undefined to unset
 */
ve.dm.TransactionProcessor.processors.attribute = function ( op ) {
	if ( !this.document.data.isElementData( this.cursor ) ) {
		throw new Error( 'Invalid element error, cannot set attributes on non-element data' );
	}
	this.queueModification( {
		type: 'setAttribute',
		args: [ this.cursor, op.key, op.to ]
	} );
};

/**
 * Verify a replace operation (the actual processing is now done in ve.dm.TreeModifier)
 *
 * @method
 * @param {Object} op Operation object
 * @param {Array} op.remove Linear model data to remove
 * @param {Array} op.insert Linear model data to insert
 */
ve.dm.TransactionProcessor.processors.replace = function ( op ) {
	var i, type;

	// Track balancedness for verification purposes only

	// Walk through the remove and insert data
	// and keep track of the element depth change (level)
	// for each of these two separately. The model is
	// only consistent if both levels are zero.
	for ( i = 0; i < op.remove.length; i++ ) {
		type = op.remove[ i ].type;
		if ( type !== undefined ) {
			if ( type.charAt( 0 ) === '/' ) {
				// Closing element
				this.replaceRemoveLevel--;
			} else {
				// Opening element
				this.replaceRemoveLevel++;
			}
		}
	}
	for ( i = 0; i < op.insert.length; i++ ) {
		type = op.insert[ i ].type;
		if ( type !== undefined ) {
			if ( type.charAt( 0 ) === '/' ) {
				// Closing element
				this.replaceInsertLevel--;
			} else {
				// Opening element
				this.replaceInsertLevel++;
			}
		}
	}
	this.advanceCursor( op.remove.length );

	this.balanced =
		this.replaceRemoveLevel === 0 &&
		this.replaceInsertLevel === 0 &&
		this.retainDepth === 0;
};
