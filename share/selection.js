'use strict';

const Util = require('util');
const Ipc = require('ipc');
const _ = require('lodash');

let _lastActiveUnit = null;
let _units = {};

const IPC_SELECTED = 'selection:selected';       // argument is an array of ids
const IPC_UNSELECTED = 'selection:unselected';   // argument is an array of ids
const IPC_ACTIVATED = 'selection:activated';     // argument is an id
const IPC_DEACTIVATED = 'selection:deactivated'; // argument is an id
const IPC_HOVERIN = 'selection:hoverin';         // argument is an id
const IPC_HOVEROUT = 'selection:hoverout';       // argument is an id
const IPC_CONTEXT = 'selection:context';
const IPC_CHANGED = 'selection:changed';
const IPC_PATCH = 'selection:patch';

function _sendToAll () {
  // send _selection:xxx for sync selection data exclude self
  var args = [].slice.call( arguments, 1 );
  args.push(Editor.selfExcluded);
  args.unshift('_'+arguments[0]);
  Editor.sendToAll.apply( Editor, args );

  // send selection:xxx for user
  Editor.sendToAll.apply( Editor, arguments );
}

/**
 * Selection module
 * @module Editor.Selection
 */

// SelectionUnit

function SelectionUnit(type) {
  this.type = type;
  this.selection = [];
  this.lastActive = null;
  this.lastHover = null;
  this._context = null; // NOTE: it is better to use lastHover, but some platform have bug with lastHover
}

SelectionUnit.prototype._activate = function (id) {
  if (this.lastActive !== id) {
    if (this.lastActive) {
      _sendToAll( IPC_DEACTIVATED, this.type, this.lastActive );
    }
    this.lastActive = id;
    _sendToAll( IPC_ACTIVATED, this.type, id );
    _lastActiveUnit = this;
  }
};

SelectionUnit.prototype._unselectOthers = function (id) {
  if (!Array.isArray(id)) {
    id = [id];
  }

  let unselected = _.difference(this.selection, id);
  if ( unselected.length ) {
    _sendToAll(IPC_UNSELECTED, this.type, unselected);

    this.selection = _.intersection(this.selection, id);

    // DISABLE NOTE:
    // use the order of the new select.
    // this needs us can synchornize order of the selection in all process.
    // this.selection = _.intersection(id, this.selection);

    return true;
  }

  return false;
};

SelectionUnit.prototype.select = function (id, unselectOthers) {
  let changed = false;

  if (!Array.isArray(id)) {
    id = [id];
  }

  if (unselectOthers) {
    changed = this._unselectOthers(id);
  }

  if ( id.length ) {
    let diff = _.difference(id, this.selection);

    if ( diff.length  ) {
      this.selection = this.selection.concat(diff);
      _sendToAll(IPC_SELECTED, this.type, diff);
      changed = true;
    }

    this._activate(id[id.length - 1]);
  }

  if ( changed )
    _sendToAll(IPC_CHANGED, this.type);
};

SelectionUnit.prototype.unselect = function (id) {
  var changed = false;
  var unselectActiveObj = false;

  if ( !Array.isArray(id) ) {
    // single
    var index = this.selection.indexOf(id);
    if (index !== -1) {
      this.selection.splice(index, 1);
      _sendToAll(IPC_UNSELECTED, this.type, [id]);
      unselectActiveObj = (id === this.lastActive);
      changed = true;
    }
  }
  else if (id.length > 0) {
    // array
    var diff = [];
    for (var i = 0; i < id.length; i++) {
      var index2 = this.selection.indexOf(id[i]);
      if (index2 !== -1) {
        this.selection.splice(index2, 1);
        diff.push(id[i]);
        unselectActiveObj = unselectActiveObj || (id[i] === this.lastActive);
      }
    }
    if (diff.length > 0) {
      _sendToAll(IPC_UNSELECTED, this.type, diff);
      changed = true;
    }
  }

  if (unselectActiveObj) {
    // activate another
    if (this.selection.length > 0) {
      this._activate(this.selection[this.selection.length - 1]);
    }
    else {
      this._activate(null);
    }
  }

  if ( changed )
    _sendToAll(IPC_CHANGED, this.type);
};

SelectionUnit.prototype.hover = function (id) {
  if ( this.lastHover !== id ) {
    if ( this.lastHover ) {
      _sendToAll(IPC_HOVEROUT, this.type, this.lastHover);
    }
    this.lastHover = id;
    if ( id ) {
      _sendToAll(IPC_HOVERIN, this.type, id);
    }
  }
};

SelectionUnit.prototype.setContext = function (id) {
  this._context = id;
  _sendToAll(IPC_CONTEXT, this.type, id);
};

SelectionUnit.prototype.patch = function (srcID, destID) {
  var idx = this.selection.indexOf(srcID);
  if ( idx !== -1 ) {
    this.selection[idx] = destID;
  }
  if ( this.lastActive === srcID ) {
    this.lastActive = destID;
  }
  if ( this.lastHover === srcID ) {
    this.lastHover = destID;
  }
  if ( this._context === srcID ) {
    this._context = destID;
  }
  _sendToAll(IPC_PATCH, this.type, srcID, destID);
};

Object.defineProperty(SelectionUnit.prototype, 'contexts', {
  get: function () {
    var id = this._context;
    if (id) {
      var index = this.selection.indexOf(id);
      if (index !== -1) {
        var selection = this.selection.slice(0);
        // make the first one as current active
        var firstToSwap = selection[0];
        selection[0] = id;
        selection[index] = firstToSwap;
        return selection;
      }
      else {
        return [id];
      }
    }
    else {
      return [];
    }
  },
  enumerable: true
});

SelectionUnit.prototype.clear = function () {
  _sendToAll(IPC_UNSELECTED, this.type, this.selection);
  this.selection = [];
  this._activate(null);

  _sendToAll(IPC_CHANGED, this.type);
};

// ConfirmableSelectionUnit

var $super = SelectionUnit;
function ConfirmableSelectionUnit (type) {
  SelectionUnit.call(this, type);

  this.confirmed = true;
  this._confirmedSnapShot = []; // for cancel
}
Util.inherits(ConfirmableSelectionUnit, $super);

ConfirmableSelectionUnit.prototype._activate = function (id) {
  if ( this.confirmed ) {
    $super.prototype._activate.call( this, id );
  }
};

function _checkConfirm (helper,confirm) {
  if ( !helper.confirmed && confirm ) {
    // confirm selecting
    helper.confirm();
  } else if ( helper.confirmed && !confirm ) {
    // take snapshot
    helper._confirmedSnapShot = helper.selection.slice();
    helper.confirmed = false;
  }
}

ConfirmableSelectionUnit.prototype.select = function (id, unselectOthers, confirm) {
  _checkConfirm(this, confirm);
  $super.prototype.select.call(this, id, unselectOthers);
};

ConfirmableSelectionUnit.prototype.unselect = function (id, confirm) {
  _checkConfirm(this, confirm);
  $super.prototype.unselect.call(this, id);
};

ConfirmableSelectionUnit.prototype.confirm = function () {
  if ( !this.confirmed ) {
    this._confirmedSnapShot = [];
    this.confirmed = true;
    if ( this.selection.length > 0 ) {
      this._activate(this.selection[this.selection.length - 1]);
    }
    else {
      this._activate(null);
    }
  }
};

ConfirmableSelectionUnit.prototype.cancel = function () {
  if ( !this.confirmed ) {
    $super.prototype.select.call(this, this._confirmedSnapShot, true);
    this._confirmedSnapShot = [];
    this.confirmed = true;
  }
};

var Selection = {
  register ( type ) {
    if ( !Editor.isCoreLevel ) {
      Editor.warn('Editor.Selection.register can only be called in core level.');
      return;
    }

    if ( _units[type] )
      return;

    _units[type] = new ConfirmableSelectionUnit(type);
  },

  /**
   * Confirms all current selecting objects, no matter which type they are.
   * This operation may trigger deactivated and activated events.
   * @method confirm
   */
  confirm () {
    for ( var p in _units ) {
      _units[p].confirm();
    }
  },

  /**
   * Cancels all current selecting objects, no matter which type they are.
   * This operation may trigger selected and unselected events.
   * @method cancel
   */
  cancel () {
    for ( var p in _units ) {
      _units[p].cancel();
    }
  },

  /**
   * if confirm === false, it means you are in rect selecting state, but have not confirmed yet.
   * in this state, the `selected` messages will be broadcasted, but the `activated` messages will not.
   * after that, if you confirm the selection, `activated` message will be sent, otherwise `unselected` message will be sent.
   * if confirm === true, the activated will be sent in the same time.
   * @method select
   * @param {string} type
   * @param {(string|string[])} id
   * @param {Boolean} [unselectOthers=true]
   * @param {Boolean} [confirm=true]
   */
  select ( type, id, unselectOthers, confirm ) {
    var selectionUnit = _units[type];
    if ( !selectionUnit ) {
      Editor.error('Can not find the type %s for selection, please register it first', type);
      return;
    }

    if ( typeof id !== 'string' && ! Array.isArray(id) ) {
      Editor.error('The 2nd argument for Editor.Selection.select must be string or array');
      return;
    }

    var lastActiveBeforeSelect = selectionUnit.lastActive;
    var lastActiveUnitBeforeSelect = _lastActiveUnit;

    unselectOthers = unselectOthers !== undefined ? unselectOthers : true;
    confirm = confirm !== undefined ? confirm : true;

    selectionUnit.select(id, unselectOthers, confirm);
    if ( selectionUnit.confirmed ) {
      _lastActiveUnit = selectionUnit;
      if ( lastActiveUnitBeforeSelect !== _lastActiveUnit ||
          lastActiveBeforeSelect !== selectionUnit.lastActive )
        {
          _sendToAll('selection:activated', type, selectionUnit.lastActive);
        }
    }
  },

  /**
   * unselect with type and id
   * @method unselect
   * @param {string} type
   * @param {(string|string[])} id
   * @param {Boolean} [confirm=true]
   */
  unselect (type, id, confirm) {
    var selectionUnit = _units[type];
    if ( !selectionUnit ) {
      Editor.error('Can not find the type %s for selection, please register it first', type);
      return;
    }

    if ( typeof id !== 'string' && ! Array.isArray(id) ) {
      Editor.error('The 2nd argument for Editor.Selection.select must be string or array');
      return;
    }

    confirm = confirm !== undefined ? confirm : true;
    selectionUnit.unselect(id, confirm);
  },

  /**
   * @method hover
   * @param {string} type
   * @param {string} id
   */
  hover ( type, id ) {
    var selectionUnit = _units[type];
    if ( !selectionUnit ) {
      Editor.error('Can not find the type %s for selection, please register it first', type);
      return;
    }

    selectionUnit.hover(id);
  },

  /**
   * @method setContext
   * @param {string} type
   * @param {string} id
   */
  setContext ( type, id ) {
    var selectionUnit = _units[type];
    if ( !selectionUnit ) {
      Editor.error('Can not find the type %s for selection, please register it first', type);
      return;
    }

    selectionUnit.setContext(id);
  },

  /**
   * @method patch
   * @param {string} type
   * @srcID {string}
   * @destID {string}
   */
  patch ( type, srcID, destID ) {
    var selectionUnit = _units[type];
    if ( !selectionUnit ) {
      Editor.error('Can not find the type %s for selection, please register it first', type);
      return;
    }

    selectionUnit.patch(srcID, destID);
  },

  /**
   * @method clear
   * @param {string} type
   */
  clear ( type ) {
    var selectionUnit = _units[type];
    if ( !selectionUnit ) {
      Editor.error('Can not find the type %s for selection, please register it first', type);
      return;
    }

    selectionUnit.clear();
    selectionUnit.confirm();
  },

  /**
   * @method hovering
   * @param {string} type
   * @return {string} hovering
   */
  hovering ( type ) {
    var selectionUnit = _units[type];
    if ( !selectionUnit ) {
      Editor.error('Can not find the type %s for selection, please register it first', type);
      return null;
    }

    return selectionUnit.lastHover;
  },

  /**
   * @method contexts
   * @param {string} type
   * @return {string} contexts
   */
  contexts ( type ) {
    var selectionUnit = _units[type];
    if ( !selectionUnit ) {
      Editor.error('Can not find the type %s for selection, please register it first', type);
      return null;
    }

    return selectionUnit.contexts;
  },

  /**
   * @method curActivate
   * @param {string} type
   * @return {string} current activated
   */
  curActivate ( type ) {
    var selectionUnit = _units[type];
    if ( !selectionUnit ) {
      Editor.error('Can not find the type %s for selection, please register it first', type);
      return null;
    }

    return selectionUnit.lastActive;
  },

  /**
   * @method curGlobalActivate
   * @return {object} - { type, id }
   */
  curGlobalActivate () {
    if ( !_lastActiveUnit ) {
      return null;
    }

    return {
      type: _lastActiveUnit.type,
      id: _lastActiveUnit.lastActive,
    };
  },

  /**
   * @method curSelection
   * @param {string} type
   * @return {string[]} selected list
   */
  curSelection: function ( type ) {
    var selectionUnit = _units[type];
    if ( !selectionUnit ) {
      Editor.error('Can not find the type %s for selection, please register it first', type);
      return null;
    }

    return selectionUnit.selection.slice();
  },

  /**
   * @method filter
   * @param {string[]} items - an array of ids
   * @param {string} mode - ['top-level', 'deep', 'name']
   * @param {function} func
   */
  filter ( items, mode, func ) {
    var results, item, i, j;

    if ( mode === 'name' ) {
      results = items.filter(func);
    }
    else {
      results = [];
      for ( i = 0; i < items.length; ++i ) {
        item = items[i];
        var add = true;

        for ( j = 0; j < results.length; ++j ) {
          var addedItem = results[j];

          if ( item === addedItem ) {
            // existed
            add = false;
            break;
          }

          var cmp = func( addedItem, item );
          if ( cmp > 0 ) {
            add = false;
            break;
          }
          else if ( cmp < 0 ) {
            results.splice(j, 1);
            --j;
          }
        }

        if ( add ) {
          results.push(item);
        }
      }
    }

    return results;
  },
};

module.exports = Selection;

// ==========================
// Ipc
// ==========================

// recv ipc message and update the local data

Ipc.on( '_selection:selected', function ( type, ids ) {
  var selectionUnit = _units[type];
  if ( !selectionUnit ) {
    Editor.error('Can not find the type %s for selection, please register it first', type);
    return;
  }

  // NOTE: it is possible we recv messages from ourself
  ids = ids.filter(function (x) {
    return selectionUnit.selection.indexOf(x) === -1;
  });

  // NOTE: we don't consider message from multiple source, in that case
  //       even the data was right, the messages still goes wrong.
  if (ids.length === 1) {
    selectionUnit.selection.push(ids[0]);
  }
  else if (ids.length > 1) {
    // NOTE: push.apply has limitation in item counts
    selectionUnit.selection = selectionUnit.selection.concat(ids);
  }
});

Ipc.on( '_selection:unselected', function ( type, ids ) {
  var selectionUnit = _units[type];
  if ( !selectionUnit ) {
    Editor.error('Can not find the type %s for selection, please register it first', type);
    return;
  }

  selectionUnit.selection = selectionUnit.selection.filter( function (x) {
    return ids.indexOf(x) === -1;
  });
});

Ipc.on( '_selection:activated', function ( type, id ) {
  var selectionUnit = _units[type];
  if ( !selectionUnit ) {
    Editor.error('Can not find the type %s for selection, please register it first', type);
    return;
  }

  _lastActiveUnit = selectionUnit;
  selectionUnit.lastActive = id;
});

Ipc.on( '_selection:deactivated', function ( type, id ) {
  unused(id);

  var selectionUnit = _units[type];
  if ( !selectionUnit ) {
    Editor.error('Can not find the type %s for selection, please register it first', type);
    return;
  }

  if ( _lastActiveUnit === selectionUnit ) {
    _lastActiveUnit = null;
  }
  selectionUnit.lastActive = null;
});

Ipc.on( '_selection:hoverin', function ( type, id ) {
  var selectionUnit = _units[type];
  if ( !selectionUnit ) {
    Editor.error('Can not find the type %s for selection, please register it first', type);
    return;
  }

  selectionUnit.lastHover = id;
});

Ipc.on( '_selection:hoverout', function ( type, id ) {
  unused(id);

  var selectionUnit = _units[type];
  if ( !selectionUnit ) {
    Editor.error('Can not find the type %s for selection, please register it first', type);
    return;
  }

  selectionUnit.lastHover = null;
});

Ipc.on( '_selection:context', function ( type, id ) {
  var selectionUnit = _units[type];
  if ( !selectionUnit ) {
    Editor.error('Can not find the type %s for selection, please register it first', type);
    return;
  }

  selectionUnit._context = id;
});

Ipc.on( '_selection:patch', function ( type, srcID, destID ) {
  var selectionUnit = _units[type];
  if ( !selectionUnit ) {
    Editor.error('Can not find the type %s for selection, please register it first', type);
    return;
  }

  //
  var idx = selectionUnit.selection.indexOf(srcID);
  if ( idx !== -1 ) {
    selectionUnit.selection[idx] = destID;
  }
  if ( selectionUnit.lastActive === srcID ) {
    selectionUnit.lastActive = destID;
  }
  if ( selectionUnit.lastHover === srcID ) {
    selectionUnit.lastHover = destID;
  }
  if ( selectionUnit._context === srcID ) {
    selectionUnit._context = destID;
  }
});

// ==========================
// init
// ==========================

if ( Editor.isCoreLevel ) {
  Ipc.on( 'selection:get-registers', function ( event ) {
    var results = [];
    for ( var key in _units ) {
      var selectionUnit = _units[key];
      results.push({
        type: key,
        selection: selectionUnit.selection,
        lastActive: selectionUnit.lastActive,
        lastHover: selectionUnit.lastHover,
        context: selectionUnit._context,
        isLastGlobalActive: selectionUnit === _lastActiveUnit,
      });
    }
    event.returnValue = results;
  });
}

if ( Editor.isPageLevel ) {
  (function () {
    var results = Editor.sendToCoreSync('selection:get-registers');
    for ( var i = 0; i < results.length; ++i ) {
      var info = results[i];
      if ( _units[info.type] )
        return;

      var selectionUnit = new ConfirmableSelectionUnit(info.type);
      selectionUnit.selection = info.selection.slice();
      selectionUnit.lastActive = info.lastActive;
      selectionUnit.lastHover = info.lastHover;
      selectionUnit._context = info.context;

      _units[info.type] = selectionUnit;

      if ( info.isLastGlobalActive ) {
        _lastActiveUnit = selectionUnit;
      }
    }
  })();
}
