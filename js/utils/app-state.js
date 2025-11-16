// Application State Management

const state = {
    connected: false,
    apiConfig: null,
    currentModule: 'dashboards',
    dashboards: [],
    filteredDashboards: [],
    selectedDashboards: new Set(),
    currentPage: 1,
    itemsPerPage: 20,
    allUsers: []
};

// Make state globally available
window.state = state;